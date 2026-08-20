import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/tools/edit.js";
import { createOutputPathGuard } from "../src/tools/output-path.js";
import { createWriteTool } from "../src/tools/write.js";

const mockedExecutor = { exec: vi.fn(), getWorkspacePath: (path: string) => path };
const dirs: string[] = [];
afterEach(async () => {
	mockedExecutor.exec.mockReset();
	await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function realExecutor() {
	const root = await mkdtemp(join(tmpdir(), "fabee-output-"));
	dirs.push(root);
	return {
		root,
		executor: {
			getWorkspacePath: (path: string) => path,
			exec: async (command: string) => {
				try {
					const { stdout, stderr } = await promisify(execFile)("/bin/bash", ["-c", command]);
					return { code: 0, stdout, stderr };
				} catch (error: any) {
					return { code: error.code || 1, stdout: error.stdout || "", stderr: error.stderr || String(error) };
				}
			},
		},
	};
}

describe("output write boundary", () => {
	it("rejects lexical writes and edits outside the session outputs directory", async () => {
		const outputPaths = createOutputPathGuard("/session/outputs");
		await expect(
			createWriteTool(mockedExecutor, outputPaths).execute("call", {
				label: "write",
				path: "../secret.txt",
				content: "no",
			}),
		).rejects.toThrow("configured output directories");
		await expect(
			createEditTool(mockedExecutor, outputPaths).execute("call", {
				label: "edit",
				path: "/workspace/file.txt",
				oldText: "a",
				newText: "b",
			}),
		).rejects.toThrow("configured output directories");
		expect(mockedExecutor.exec).not.toHaveBeenCalled();
	});

	it("resolves relative writes inside the output root and permits editing them", async () => {
		const { root, executor } = await realExecutor();
		const outputs = join(root, "session", "outputs");
		const outputPaths = createOutputPathGuard(outputs);
		await createWriteTool(executor, outputPaths).execute("call", {
			label: "write",
			path: "reports/result.txt",
			content: "before",
		});
		expect(await readFile(join(outputs, "reports/result.txt"), "utf8")).toBe("before");
		await createEditTool(executor, outputPaths).execute("call", {
			label: "edit",
			path: "reports/result.txt",
			oldText: "before",
			newText: "after",
		});
		expect(await readFile(join(outputs, "reports/result.txt"), "utf8")).toBe("after");
	});

	it("allows absolute writes inside an explicitly configured additional root", async () => {
		const { root, executor } = await realExecutor();
		const outputs = join(root, "session", "outputs");
		const taskLogs = join(root, "project", "docs", "log", "tasks");
		const outputPaths = createOutputPathGuard(outputs, [taskLogs]);
		await createWriteTool(executor, outputPaths).execute("call", {
			label: "write task log",
			path: join(taskLogs, "2026-08-20_result.md"),
			content: "documented",
		});
		expect(await readFile(join(taskLogs, "2026-08-20_result.md"), "utf8")).toBe("documented");
		await expect(
			createWriteTool(executor, outputPaths).execute("call", {
				label: "write model",
				path: join(root, "project", "models", "changed.sql"),
				content: "not allowed",
			}),
		).rejects.toThrow("configured output directories");
	});

	it("rejects existing file and parent-directory symlinks that escape", async () => {
		const { root, executor } = await realExecutor();
		const outputs = join(root, "session", "outputs");
		const outputPaths = createOutputPathGuard(outputs);
		const outside = join(root, "outside");
		await mkdir(outputs, { recursive: true });
		await mkdir(outside);
		await writeFile(join(outside, "secret.txt"), "safe");
		await symlink(outside, join(outputs, "escape"));
		await symlink(join(outside, "secret.txt"), join(outputs, "file-link"));
		await expect(
			createWriteTool(executor, outputPaths).execute("call", {
				label: "write",
				path: "escape/new.txt",
				content: "bad",
			}),
		).rejects.toThrow();
		await expect(
			createWriteTool(executor, outputPaths).execute("call", {
				label: "write",
				path: "file-link",
				content: "bad",
			}),
		).rejects.toThrow();
		expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("safe");
	});
});
