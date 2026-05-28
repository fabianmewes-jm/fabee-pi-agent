import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createChartTool } from "../src/tools/chart.js";
import { createDbtTool } from "../src/tools/dbt.js";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "fabee-flow-test-"));
}

describe("dbt to chart complete flow", () => {
	it("writes dbt JSON output and renders it into a registered PNG chart artifact", async () => {
		const sessionDir = await tempDir();
		const exec = vi.fn().mockResolvedValue({
			stdout: JSON.stringify({
				show: [
					{ month: "2026-01", applications_count: 6946 },
					{ month: "2026-02", applications_count: 6083 },
					{ month: "2026-03", applications_count: 7238 },
				],
			}),
			stderr: "",
			code: 0,
		});
		const executor = { exec, getWorkspacePath: (path: string) => path };
		const dbt = createDbtTool(executor, sessionDir, sessionDir, sessionDir);

		const dbtResult = await dbt.execute("dbt-show", {
			label: "Applications by month",
			action: "show",
			inlineSql: "select month, applications_count from applications_by_month",
			output: "json",
		});

		expect(exec.mock.calls[0][0]).toContain("show");
		expect(exec.mock.calls[0][0]).toContain("--output 'json'");
		const jsonOutputPath = dbtResult.details?.jsonOutputPath;
		expect(jsonOutputPath).toMatch(/outputs\/dbt-show-.*\.json$/);
		expect(JSON.parse(await readFile(jsonOutputPath as string, "utf-8"))).toEqual({
			show: [
				{ month: "2026-01", applications_count: 6946 },
				{ month: "2026-02", applications_count: 6083 },
				{ month: "2026-03", applications_count: 7238 },
			],
		});

		const artifacts: unknown[] = [];
		const chart = createChartTool(async (artifact) => {
			artifacts.push(artifact);
		}, sessionDir);

		const chartResult = await chart.execute("chart", {
			label: "Render applications chart",
			inputPath: jsonOutputPath as string,
			chartSpec: {
				type: "bar",
				x: "month",
				y: "applications_count",
				title: "Applications by month",
			},
			outputName: "applications-2026-by-month.png",
			title: "Applications 2026 by month",
		});

		const pngPath = join(sessionDir, "outputs", "charts", "applications-2026-by-month.png");
		const png = await readFile(pngPath);
		expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		expect((chartResult.content[0] as { text: string }).text).toContain(
			"Rendered chart artifact applications-2026-by-month.png",
		);
		expect(artifacts).toEqual([
			expect.objectContaining({
				path: pngPath,
				name: "applications-2026-by-month.png",
				title: "Applications 2026 by month",
				mimeType: "image/png",
			}),
		]);
	});
});
