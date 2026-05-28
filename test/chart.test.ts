import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerLocalBlobStore } from "../src/blob-store.js";
import {
	buildChartConfigFromRows,
	buildPieChartConfigFromRows,
	createChartTool,
	normalizeRows,
	renderChartConfigToPng,
} from "../src/tools/chart.js";
import { createWorkerTools } from "../src/tools/index.js";
import type { WorkerRunRequest } from "../src/types.js";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "fabee-chart-test-"));
}

afterEach(() => {
	delete process.env.BEE_PI_AGENT_CHART_MAX_PNG_BYTES;
});

describe("chart helpers", () => {
	it("normalizes supported row containers", () => {
		expect(normalizeRows({ show: [{ x: "a", y: 1 }] })).toEqual([{ x: "a", y: 1 }]);
		expect(normalizeRows([{ x: "a", y: 1 }])).toEqual([{ x: "a", y: 1 }]);
		expect(normalizeRows({ rows: [{ x: "a", y: 1 }] })).toEqual([{ x: "a", y: 1 }]);
		expect(normalizeRows({ data: [{ x: "a", y: 1 }] })).toEqual([{ x: "a", y: 1 }]);
	});

	it("renders a simple bar chart PNG", () => {
		const config = buildChartConfigFromRows(
			[
				{ day: "2026-05-01", likes: 3 },
				{ day: "2026-05-02", likes: 5 },
			],
			{ type: "bar", x: "day", y: "likes", title: "Likes" },
		);
		const scales = config.options?.scales as Record<string, { title?: { display?: boolean; text?: string } }>;
		expect(scales.x.title).toMatchObject({ display: true, text: "Day" });
		expect(scales.y.title).toMatchObject({ display: true, text: "Likes" });
		expect((config.options?.plugins as Record<string, unknown>).fabeeValueLabels).toMatchObject({ display: true });
		const png = renderChartConfigToPng(config, 600, 300);
		expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		expect(png.length).toBeGreaterThan(1000);
	});

	it("supports grouped line charts and seriesFields", () => {
		const grouped = buildChartConfigFromRows(
			[
				{ day: "1", kind: "a", likes: 1 },
				{ day: "1", kind: "b", likes: 2 },
				{ day: "2", kind: "a", likes: 3 },
			],
			{ type: "line", x: "day", y: "likes", series: "kind", missingValue: 0 },
		);
		expect(grouped.data.datasets).toHaveLength(2);

		const multiMetric = buildChartConfigFromRows(
			[
				{ day: "1", likes: 1, views: 10 },
				{ day: "2", likes: 2, views: 20 },
			],
			{ type: "bar", x: "day", seriesFields: ["likes", "views"] },
		);
		expect(multiMetric.data.datasets).toHaveLength(2);
	});

	it("validates metric values, duplicates, and pie negatives", () => {
		expect(() => buildChartConfigFromRows([{ day: "1", likes: "3" }], { type: "bar", x: "day", y: "likes" })).toThrow(
			/expected a JSON number/,
		);
		expect(() =>
			buildChartConfigFromRows([{ day: "1", likes: null }], { type: "bar", x: "day", y: "likes" }),
		).toThrow(/Null metric value/);
		expect(
			buildChartConfigFromRows([{ day: "1", likes: null }], {
				type: "line",
				x: "day",
				y: "likes",
				allowNullValues: true,
			}).data.datasets[0].data,
		).toEqual([null]);
		expect(
			buildChartConfigFromRows([{ day: "1", likes: 0 }], { type: "bar", x: "day", y: "likes" }).data.datasets[0]
				.data,
		).toEqual([0]);
		expect(
			buildChartConfigFromRows([{ day: "1", likes: -5 }], { type: "line", x: "day", y: "likes" }).data.datasets[0]
				.data,
		).toEqual([-5]);
		expect(() =>
			buildChartConfigFromRows(
				[
					{ day: "1", likes: 1 },
					{ day: "1", likes: 2 },
				],
				{ type: "bar", x: "day", y: "likes" },
			),
		).toThrow(/Duplicate point/);
		expect(
			buildChartConfigFromRows(
				[
					{ day: "1", likes: 1 },
					{ day: "1", likes: 2 },
				],
				{ type: "bar", x: "day", y: "likes", aggregate: "sum" },
			).data.datasets[0].data,
		).toEqual([3]);
		expect(() =>
			buildPieChartConfigFromRows([{ kind: "a", value: -1 }], { type: "pie", category: "kind", y: "value" }),
		).toThrow(/not be negative/);
	});

	it("includes available fields and a sample row in missing field errors", () => {
		expect(() =>
			buildChartConfigFromRows([{ day: "2026-05-01", likes: 7 }], {
				type: "bar",
				x: "missing_day",
				y: "likes",
			}),
		).toThrow(/Missing x-axis field "missing_day"[\s\S]*Available fields: day, likes\.[\s\S]*Sample row:/);
	});

	it("enforces row, label, and dataset limits", () => {
		expect(() => normalizeRows(Array.from({ length: 5001 }, (_, index) => ({ x: index, y: index })))).toThrow(
			/Too many rows: 5001/,
		);
		expect(() =>
			buildChartConfigFromRows(
				Array.from({ length: 201 }, (_, index) => ({ day: `day-${index}`, likes: index })),
				{ type: "bar", x: "day", y: "likes" },
			),
		).toThrow(/Too many labels: 201/);

		const row = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`metric_${index}`, index]));
		expect(() =>
			buildChartConfigFromRows([{ day: "1", ...row }], {
				type: "bar",
				x: "day",
				seriesFields: Object.keys(row),
			}),
		).toThrow(/Too many datasets: 21/);
	});

	it("renders doughnut charts and handles maxSlices grouping explicitly", () => {
		const rows = [
			{ kind: "a", value: 10 },
			{ kind: "b", value: 5 },
			{ kind: "c", value: 2 },
			{ kind: "d", value: 1 },
		];
		expect(() =>
			buildPieChartConfigFromRows(rows, { type: "doughnut", category: "kind", value: "value", maxSlices: 3 }),
		).toThrow(/Too many slices: 4 exceeds maxSlices 3/);

		const grouped = buildPieChartConfigFromRows(rows, {
			type: "doughnut",
			category: "kind",
			value: "value",
			maxSlices: 3,
			groupOthers: true,
			otherLabel: "Rest",
		});
		expect(grouped.type).toBe("doughnut");
		expect(grouped.data.labels).toEqual(["a", "b", "Rest"]);
		expect(grouped.data.datasets[0].data).toEqual([10, 5, 3]);
	});
});

describe("chart tool", () => {
	it("reads JSON and writes a visible PNG without registering an artifact", async () => {
		const sessionDir = await tempDir();
		const inputPath = join(sessionDir, "input.json");
		await writeFile(inputPath, JSON.stringify({ show: [{ day: "2026-05-01", likes: 7 }] }), "utf-8");
		const tool = createChartTool(sessionDir);

		const result = await tool.execute("tool-call", {
			label: "Render chart",
			inputPath,
			chartSpec: { type: "bar", x: "day", y: "likes" },
			outputName: "likes.png",
		});

		expect((result.content[0] as { text: string }).text).toContain("Rendered chart file likes.png");
		const outputPath = join(sessionDir, "outputs", "charts", "likes.png");
		expect((await readFile(outputPath)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
	});

	it("rejects non-json input paths", async () => {
		const sessionDir = await tempDir();
		const tool = createChartTool(sessionDir);
		await expect(
			tool.execute("tool-call", {
				label: "Render chart",
				inputPath: join(sessionDir, "input.txt"),
				chartSpec: { type: "bar", x: "day", y: "likes" },
			}),
		).rejects.toThrow(/\.json/);
	});

	it("rejects oversized JSON inputs before parsing", async () => {
		const sessionDir = await tempDir();
		const inputPath = join(sessionDir, "too-large.json");
		await writeFile(inputPath, Buffer.alloc(10 * 1024 * 1024 + 1));
		const tool = createChartTool(sessionDir);

		await expect(
			tool.execute("tool-call", {
				label: "Render chart",
				inputPath,
				chartSpec: { type: "bar", x: "day", y: "likes" },
			}),
		).rejects.toThrow(/too large/);
	});

	it("enforces the chart-specific PNG size limit", async () => {
		process.env.BEE_PI_AGENT_CHART_MAX_PNG_BYTES = "1";
		const sessionDir = await tempDir();
		const inputPath = join(sessionDir, "input.json");
		await writeFile(inputPath, JSON.stringify({ show: [{ day: "2026-05-01", likes: 7 }] }), "utf-8");
		const tool = createChartTool(sessionDir);

		await expect(
			tool.execute("tool-call", {
				label: "Render chart",
				inputPath,
				chartSpec: { type: "bar", x: "day", y: "likes" },
			}),
		).rejects.toThrow(/exceeding chart inline-safe limit 1 bytes/);
	});
});

describe("artifact plumbing", () => {
	it("stores buffer artifacts in the local blob store", async () => {
		const root = await tempDir();
		const store = new WorkerLocalBlobStore(root);
		const artifact = await store.putArtifact({
			namespace: "artifacts/session/run",
			data: Buffer.from("hello"),
			name: "hello.txt",
			mimeType: "text/plain",
		});
		expect(artifact.mimeType).toBe("text/plain");
		expect(artifact.sizeBytes).toBe(5);
		expect(await readFile(join(root, artifact.blobKey), "utf-8")).toBe("hello");
	});

	it("registers dbt and chart as builtin worker tools", async () => {
		const sessionDir = await tempDir();
		const tools = await createWorkerTools({
			executor: {
				exec: vi.fn(),
				getWorkspacePath: (path) => path,
			},
			artifactHandler: vi.fn(),
			request: {
				sessionId: "session-1",
				conversation: { conversationId: "conversation-1" },
				actor: { userId: "user-1" },
				message: { text: "hi" },
			} satisfies WorkerRunRequest,
			workspaceRoot: sessionDir,
			workingDir: sessionDir,
			stateDir: sessionDir,
			sessionDir,
		});
		expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["dbt", "chart"]));
	});
});
