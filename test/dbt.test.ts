import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDbtTool, extractDbtJsonRows } from "../src/tools/dbt.js";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "fabee-dbt-test-"));
}

describe("dbt JSON extraction", () => {
	it("extracts direct stdout JSON", () => {
		expect(extractDbtJsonRows('{"show":[{"id":1}]}')).toEqual([{ id: 1 }]);
	});

	it("extracts balanced JSON from mixed stdout and supports containers", () => {
		expect(extractDbtJsonRows('log before\n[{"id":1}]\nlog after')).toEqual([{ id: 1 }]);
		expect(extractDbtJsonRows('log before\n{"rows":[{"id":2}]}\nlog after')).toEqual([{ id: 2 }]);
		expect(extractDbtJsonRows('log before\n{"data":[{"id":3}]}\nlog after')).toEqual([{ id: 3 }]);
	});

	it("prefers the last valid show payload when multiple candidates exist", () => {
		expect(extractDbtJsonRows('{"show":[{"id":1}]}\n{"rows":[{"id":2}]}')).toEqual([{ id: 1 }]);
		expect(extractDbtJsonRows('{"show":[{"id":1}]}\n{"show":[{"id":3}]}')).toEqual([{ id: 3 }]);
	});

	it("falls back to stdout plus stderr", () => {
		expect(extractDbtJsonRows("stdout log", 'stderr log\n{"show":[{"id":4}]}')).toEqual([{ id: 4 }]);
	});

	it("throws a helpful error when no JSON payload is present", () => {
		expect(() => extractDbtJsonRows("dbt log only", "stderr warning only")).toThrow(
			/Could not extract clean dbt JSON payload/,
		);
	});
});

describe("dbt tool JSON output", () => {
	it("rejects dbt build and run because analytics should use already-built prod models", async () => {
		const sessionDir = await tempDir();
		const exec = vi.fn();
		const tool = createDbtTool({ exec, getWorkspacePath: (path) => path }, sessionDir, sessionDir, sessionDir);

		await expect(
			tool.execute("tool-call", {
				label: "Build model",
				action: "build",
				select: "my_model",
			}),
		).rejects.toThrow(/Unsupported dbt action 'build'/);
		await expect(
			tool.execute("tool-call", {
				label: "Run model",
				action: "run",
				select: "my_model",
			}),
		).rejects.toThrow(/Unsupported dbt action 'run'/);
		expect(exec).not.toHaveBeenCalled();
	});

	it("writes canonical { show: [...] } JSON to session outputs for dbt show --output json", async () => {
		const sessionDir = await tempDir();
		const exec = vi.fn().mockResolvedValue({
			stdout: '[{"id":1,"name":"alpha"}]',
			stderr: "",
			code: 0,
		});
		const tool = createDbtTool({ exec, getWorkspacePath: (path) => path }, sessionDir, sessionDir, sessionDir);

		const result = await tool.execute("tool-call", {
			label: "Show rows",
			action: "show",
			inlineSql: "select 1 as id",
			output: "json",
		});

		expect(exec.mock.calls[0][0]).toContain("show");
		expect(exec.mock.calls[0][0]).toContain("--output 'json'");
		expect(result.details?.jsonOutputPath).toMatch(/outputs\/dbt-show-.*\.json$/);
		expect(JSON.parse(await readFile(result.details?.jsonOutputPath as string, "utf-8"))).toEqual({
			show: [{ id: 1, name: "alpha" }],
		});
		expect(result.details).toMatchObject({
			rowCount: 1,
			fields: ["id", "name"],
			fieldTypes: { id: "number", name: "string" },
			fullJson: { show: [{ id: 1, name: "alpha" }] },
		});
		expect((result.content[0] as { text: string }).text).toContain("Wrote clean dbt JSON output");
	});

	it("jsonOutputPath forces --output json and writes to the provided path", async () => {
		const sessionDir = await tempDir();
		const outputPath = join(sessionDir, "custom.json");
		const exec = vi.fn().mockResolvedValue({
			stdout: 'dbt log\n{"show":[{"id":2}]}\n',
			stderr: "",
			code: 0,
		});
		const tool = createDbtTool({ exec, getWorkspacePath: (path) => path }, sessionDir, sessionDir, sessionDir);

		const result = await tool.execute("tool-call", {
			label: "Show rows",
			action: "show",
			select: "my_model",
			jsonOutputPath: outputPath,
		});

		expect(exec.mock.calls[0][0]).toContain("--output 'json'");
		expect(result.details?.jsonOutputPath).toBe(outputPath);
		expect(JSON.parse(await readFile(outputPath, "utf-8"))).toEqual({ show: [{ id: 2 }] });
	});

	it("uses stdout plus stderr fallback when writing tool JSON output", async () => {
		const sessionDir = await tempDir();
		const exec = vi.fn().mockResolvedValue({
			stdout: "dbt log without the result payload",
			stderr: 'adapter log\n{"show":[{"id":4,"name":"from-stderr"}]}',
			code: 0,
		});
		const tool = createDbtTool({ exec, getWorkspacePath: (path) => path }, sessionDir, sessionDir, sessionDir);

		const result = await tool.execute("tool-call", {
			label: "Show rows",
			action: "show",
			select: "my_model",
			output: "json",
		});

		expect(result.details?.jsonOutputPath).toMatch(/outputs\/dbt-show-.*\.json$/);
		expect(JSON.parse(await readFile(result.details?.jsonOutputPath as string, "utf-8"))).toEqual({
			show: [{ id: 4, name: "from-stderr" }],
		});
		expect(result.details).toMatchObject({
			rowCount: 1,
			fields: ["id", "name"],
			fieldTypes: { id: "number", name: "string" },
		});
	});

	it("omits full JSON from the tool result for larger resultsets", async () => {
		const sessionDir = await tempDir();
		const rows = Array.from({ length: 101 }, (_, id) => ({ id }));
		const exec = vi.fn().mockResolvedValue({
			stdout: JSON.stringify({ show: rows }),
			stderr: "",
			code: 0,
		});
		const tool = createDbtTool({ exec, getWorkspacePath: (path) => path }, sessionDir, sessionDir, sessionDir);

		const result = await tool.execute("tool-call", {
			label: "Show rows",
			action: "show",
			select: "my_model",
			output: "json",
		});

		expect(result.details?.rowCount).toBe(101);
		expect(result.details?.fullJson).toBeUndefined();
		expect((result.content[0] as { text: string }).text).toContain("Full JSON omitted");
	});

	it("omits full JSON from the tool result when the canonical JSON exceeds 50 KiB", async () => {
		const sessionDir = await tempDir();
		const rows = [{ id: 1, payload: "x".repeat(51 * 1024) }];
		const exec = vi.fn().mockResolvedValue({
			stdout: JSON.stringify({ show: rows }),
			stderr: "",
			code: 0,
		});
		const tool = createDbtTool({ exec, getWorkspacePath: (path) => path }, sessionDir, sessionDir, sessionDir);

		const result = await tool.execute("tool-call", {
			label: "Show rows",
			action: "show",
			select: "my_model",
			output: "json",
		});

		expect(result.details?.rowCount).toBe(1);
		expect(result.details?.sampleRows).toEqual(rows);
		expect(result.details?.fullJson).toBeUndefined();
		expect(JSON.parse(await readFile(result.details?.jsonOutputPath as string, "utf-8"))).toEqual({ show: rows });
		expect((result.content[0] as { text: string }).text).toContain("Full JSON omitted");
	});

	it("fails when dbt show --output json returns no valid JSON payload", async () => {
		const sessionDir = await tempDir();
		const exec = vi.fn().mockResolvedValue({
			stdout: "dbt log only",
			stderr: "warning only",
			code: 0,
		});
		const tool = createDbtTool({ exec, getWorkspacePath: (path) => path }, sessionDir, sessionDir, sessionDir);

		await expect(
			tool.execute("tool-call", {
				label: "Show rows",
				action: "show",
				select: "my_model",
				output: "json",
			}),
		).rejects.toThrow(/Could not extract clean dbt JSON payload/);
	});
});
