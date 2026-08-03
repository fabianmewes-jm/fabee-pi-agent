import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAttachTool } from "../src/tools/attach.js";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "fabee-attach-test-"));
}

describe("attach tool", () => {
	it.each([
		["report.csv", "text/csv"],
		["chart.png", "image/png"],
		["photo.jpg", "image/jpeg"],
		["document.pdf", "application/pdf"],
	])("marks attached %s files with the correct MIME type", async (filename, mimeType) => {
		const root = await tempDir();
		const filePath = join(root, filename);
		await writeFile(filePath, "test data");

		const artifactHandler = vi.fn().mockResolvedValue(undefined);
		const tool = createAttachTool(artifactHandler);

		await tool.execute("tool-call-1", { label: "Artifact", path: filePath });

		expect(artifactHandler).toHaveBeenCalledWith(
			expect.objectContaining({
				path: filePath,
				name: filename,
				title: filename,
				mimeType,
			}),
		);
	});
});
