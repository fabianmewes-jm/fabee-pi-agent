import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { createChartTool } from "../dist/tools/chart.js";

const sessionDir = await mkdtemp(join(tmpdir(), "fabee-chart-smoke-"));
const inputPath = join(sessionDir, "applications-2026-by-month.json");

await writeFile(
	inputPath,
	`${JSON.stringify(
		{
			show: [
				{ month: "2026-01", applications_count: 6946 },
				{ month: "2026-02", applications_count: 6083 },
				{ month: "2026-03", applications_count: 7238 },
				{ month: "2026-04", applications_count: 6155 },
				{ month: "2026-05", applications_count: 4523 },
			],
		},
		null,
		2,
	)}\n`,
	"utf-8",
);

const artifacts = [];
const tool = createChartTool(async (artifact) => {
	artifacts.push(artifact);
}, sessionDir);

const result = await tool.execute("chart-smoke", {
	label: "Chart smoke test",
	inputPath,
	chartSpec: {
		type: "bar",
		x: "month",
		y: "applications_count",
		title: "Applications by month in 2026",
		xLabel: "Month",
		yLabel: "Applications",
	},
	outputName: "applications-2026-by-month.png",
	title: "Applications 2026 by month",
	width: 1000,
	height: 550,
});

const png = await readFile(result.details.outputPath);
const magic = png.subarray(0, 8).toString("hex");
if (magic !== "89504e470d0a1a0a") {
	throw new Error(`Expected PNG magic header, got ${magic}`);
}
if (!artifacts.some((artifact) => artifact.mimeType === "image/png")) {
	throw new Error("Expected chart smoke artifactHandler to receive mimeType image/png");
}

const canvas = createCanvas(1, 1);
console.log(
	JSON.stringify(
		{
			ok: true,
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			canvasAvailable: Boolean(canvas),
			outputPath: result.details.outputPath,
			pngBytes: png.length,
			magic,
			artifactMimeTypes: artifacts.map((artifact) => artifact.mimeType),
		},
		null,
		2,
	),
);
