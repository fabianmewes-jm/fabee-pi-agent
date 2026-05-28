import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAttachTool } from "../src/tools/attach.js";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "fabee-attach-test-"));
}

describe("attach tool", () => {
	it("marks attached CSV files as text/csv artifacts", async () => {
		const root = await tempDir();
		const csvPath = join(root, "report.csv");
		await writeFile(csvPath, "name,value\nfoo,1\n");

		const artifactHandler = vi.fn().mockResolvedValue(undefined);
		const tool = createAttachTool(artifactHandler);

		await tool.execute("tool-call-1", { label: "CSV export", path: csvPath });

		expect(artifactHandler).toHaveBeenCalledWith(
			expect.objectContaining({
				path: csvPath,
				name: "report.csv",
				title: "report.csv",
				mimeType: "text/csv",
			}),
		);
	});
});
