import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createCanvas } from "@napi-rs/canvas";
import { Type } from "@sinclair/typebox";
import { Chart, type ChartConfiguration, type Plugin, registerables } from "chart.js";
import type { ArtifactHandler } from "./attach.js";

Chart.register(...registerables);

export const DEFAULT_PALETTE = [
	"#2563eb",
	"#dc2626",
	"#16a34a",
	"#9333ea",
	"#ea580c",
	"#0891b2",
	"#4f46e5",
	"#be123c",
	"#15803d",
	"#a16207",
];

const MAX_ROWS = 5000;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_LABELS = 200;
const MAX_DATASETS = 20;
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1000;
const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 550;
const DEFAULT_MAX_PNG_BYTES = 650_000;
const PNG_MAGIC = "89504e470d0a1a0a";

const chartSchema = Type.Object({
	label: Type.String({ description: "Brief description of the chart to render (shown to user)" }),
	inputPath: Type.String({ description: "Path to a clean .json file containing { show: [...] } dbt rows" }),
	chartSpec: Type.Optional(Type.Any({ description: "Line/bar chart spec" })),
	pieSpec: Type.Optional(Type.Any({ description: "Pie/doughnut chart spec" })),
	outputName: Type.Optional(
		Type.String({ description: "Optional PNG filename. Will be sanitized and forced to .png" }),
	),
	title: Type.Optional(Type.String({ description: "Optional artifact/chart title" })),
	width: Type.Optional(Type.Number({ description: "Chart width in pixels" })),
	height: Type.Optional(Type.Number({ description: "Chart height in pixels" })),
});

type Row = Record<string, unknown>;
type Aggregate = "sum" | "avg" | "min" | "max" | "first";
type ChartType = "line" | "bar";
type PieType = "pie" | "doughnut";

export interface ChartSpec {
	type: ChartType;
	x: string;
	y?: string;
	series?: string;
	seriesFields?: string[];
	title?: string;
	xLabel?: string;
	yLabel?: string;
	labels?: Record<string, string>;
	legendPosition?: "top" | "bottom" | "left" | "right";
	stacked?: boolean;
	sortLabels?: boolean;
	sortSeries?: boolean;
	aggregate?: Aggregate;
	missingValue?: number | null;
	allowNullValues?: boolean;
	palette?: string[];
	dataLabels?: boolean;
}

export interface PieSpec {
	type: PieType;
	category?: string;
	label?: string;
	y?: string;
	value?: string;
	title?: string;
	legendPosition?: "top" | "bottom" | "left" | "right";
	aggregate?: Aggregate;
	maxSlices?: number;
	groupOthers?: boolean;
	otherLabel?: string;
	palette?: string[];
	dataLabels?: boolean;
}

function isRecord(value: unknown): value is Row {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRows(value: unknown): Row[] {
	const rows = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.show)
			? value.show
			: isRecord(value) && Array.isArray(value.rows)
				? value.rows
				: isRecord(value) && Array.isArray(value.data)
					? value.data
					: undefined;
	if (!rows) {
		throw new Error("Expected chart input JSON to be an array or an object with a show/rows/data array");
	}
	if (!rows.every(isRecord)) {
		throw new Error("Expected every chart input row to be a JSON object");
	}
	if (rows.length > MAX_ROWS) {
		throw validationError(`Too many rows: ${rows.length}. Limit is ${MAX_ROWS}.`, rows);
	}
	return rows;
}

function availableFields(rows: Row[]): string[] {
	return Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
}

function validationError(message: string, rows: Row[], hint?: string): Error {
	const lines = [`Chart validation failed: ${message}`, `Row count: ${rows.length}.`];
	const fields = availableFields(rows);
	if (fields.length > 0) lines.push(`Available fields: ${fields.join(", ")}.`);
	if (rows[0]) lines.push(`Sample row: ${JSON.stringify(rows[0])}`);
	if (hint) lines.push(hint);
	return new Error(lines.join("\n"));
}

function assertField(rows: Row[], field: string | undefined, role: string): asserts field is string {
	if (!field) throw validationError(`Missing required ${role} field.`, rows);
	if (rows.length === 0) return;
	if (!availableFields(rows).includes(field)) {
		throw validationError(`Missing ${role} field "${field}".`, rows);
	}
}

function assertString(value: unknown, name: string, rows: Row[]): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw validationError(`${name} must be a non-empty string.`, rows);
	}
}

function assertAggregate(value: unknown, rows: Row[]): asserts value is Aggregate | undefined {
	if (value === undefined) return;
	if (!["sum", "avg", "min", "max", "first"].includes(String(value))) {
		throw validationError(`Unsupported aggregate "${String(value)}". Use sum, avg, min, max, or first.`, rows);
	}
}

function assertPalette(value: unknown, rows: Row[]): string[] {
	if (value === undefined) return DEFAULT_PALETTE;
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		!value.every((entry) => typeof entry === "string" && entry.length > 0)
	) {
		throw validationError("palette must be a non-empty array of color strings.", rows);
	}
	return value;
}

function assertMetricValue(value: unknown, field: string, rows: Row[], allowNullValues = false): number | null {
	if (value === null) {
		if (allowNullValues) return null;
		throw validationError(
			`Null metric value in field "${field}".`,
			rows,
			"Set allowNullValues: true to allow line/bar gaps.",
		);
	}
	if (typeof value === "string") {
		throw validationError(
			`Metric field "${field}" contains numeric/string value ${JSON.stringify(value)}; expected a JSON number.`,
			rows,
		);
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw validationError(`Metric field "${field}" must contain finite JSON numbers.`, rows);
	}
	return value;
}

function aggregateValues(values: (number | null)[], aggregate: Aggregate): number | null {
	const numbers = values.filter((value): value is number => value !== null);
	if (numbers.length === 0) return null;
	if (aggregate === "first") return numbers[0];
	if (aggregate === "avg") return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
	if (aggregate === "min") return Math.min(...numbers);
	if (aggregate === "max") return Math.max(...numbers);
	return numbers.reduce((sum, value) => sum + value, 0);
}

function uniqueByString(values: unknown[], sort = false): string[] {
	const unique = Array.from(new Set(values.map((value) => String(value))));
	return sort ? unique.sort((a, b) => a.localeCompare(b)) : unique;
}

function humanizeFieldName(field: string | undefined, fallback: string): string {
	if (!field) return fallback;
	return field
		.replace(/^[0-9]+_/, "")
		.replace(/__/g, " ")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatChartValue(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value);
	}
	return String(value ?? "");
}

const whiteBackgroundPlugin: Plugin = {
	id: "fabeeWhiteBackground",
	beforeDraw: (chart) => {
		const { ctx, height, width } = chart;
		ctx.save();
		ctx.globalCompositeOperation = "destination-over";
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, width, height);
		ctx.restore();
	},
};

const valueLabelsPlugin: Plugin = {
	id: "fabeeValueLabels",
	afterDatasetsDraw: (chart) => {
		const pluginOptions = (chart.options.plugins as Record<string, unknown> | undefined)?.fabeeValueLabels as
			| { display?: boolean }
			| undefined;
		if (pluginOptions?.display === false) return;
		const { ctx } = chart;
		ctx.save();
		ctx.fillStyle = "#111827";
		ctx.font = "600 12px sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "bottom";

		for (const dataset of chart.data.datasets) {
			const datasetIndex = chart.data.datasets.indexOf(dataset);
			const meta = chart.getDatasetMeta(datasetIndex);
			if (meta.hidden) continue;
			for (let index = 0; index < meta.data.length; index += 1) {
				const rawValue = Array.isArray(dataset.data) ? dataset.data[index] : undefined;
				if (rawValue === null || rawValue === undefined) continue;
				const point = meta.data[index]?.tooltipPosition(true);
				if (!point || point.x === null || point.y === null) continue;
				ctx.fillText(formatChartValue(rawValue), point.x, Math.max(14, point.y - 6));
			}
		}
		ctx.restore();
	},
};

function datasetStyle(index: number, type: ChartType, palette: string[]) {
	const color = palette[index % palette.length];
	return {
		borderColor: color,
		backgroundColor: type === "line" ? color : `${color}cc`,
		tension: type === "line" ? 0.25 : undefined,
		spanGaps: type === "line" ? true : undefined,
	};
}

function getPointValue(
	rows: Row[],
	field: string,
	aggregate: Aggregate | undefined,
	allowNullValues: boolean,
): number | null {
	const values = rows.map((row) => assertMetricValue(row[field], field, rows, allowNullValues));
	if (values.length === 0) return null;
	if (!aggregate && values.length > 1) {
		throw validationError(
			`Duplicate point for metric field "${field}". Set aggregate explicitly to combine duplicates.`,
			rows,
		);
	}
	return aggregate ? aggregateValues(values, aggregate) : values[0];
}

export function buildChartConfigFromRows(rows: Row[], rawSpec: unknown): ChartConfiguration {
	if (!isRecord(rawSpec)) throw validationError("chartSpec is required and must be an object.", rows);
	const spec = rawSpec as unknown as ChartSpec;
	if (spec.type !== "line" && spec.type !== "bar") {
		throw validationError(`Unsupported chart type "${String(spec.type)}". Supported: line, bar.`, rows);
	}
	assertString(spec.x, "chartSpec.x", rows);
	assertField(rows, spec.x, "x-axis");
	assertAggregate(spec.aggregate, rows);
	if (spec.series && spec.seriesFields) throw validationError("Use either series or seriesFields, not both.", rows);
	if (!spec.y && !spec.seriesFields) throw validationError("Either y or seriesFields is required.", rows);
	if (spec.y) assertField(rows, spec.y, "y-axis");
	if (spec.series) assertField(rows, spec.series, "series");
	if (spec.seriesFields !== undefined) {
		if (!Array.isArray(spec.seriesFields) || spec.seriesFields.length === 0) {
			throw validationError("seriesFields must be a non-empty array.", rows);
		}
		for (const field of spec.seriesFields) assertField(rows, field, "seriesFields");
	}
	const palette = assertPalette(spec.palette, rows);
	const labels = uniqueByString(
		rows.map((row) => row[spec.x]),
		spec.sortLabels ?? false,
	);
	if (labels.length > MAX_LABELS)
		throw validationError(`Too many labels: ${labels.length}. Limit is ${MAX_LABELS}.`, rows);

	const allowNullValues = spec.allowNullValues ?? false;
	const missingValue = spec.missingValue === undefined ? null : spec.missingValue;
	if (missingValue !== null && (typeof missingValue !== "number" || !Number.isFinite(missingValue))) {
		throw validationError("missingValue must be null or a finite number.", rows);
	}

	let datasets: ChartConfiguration["data"]["datasets"];
	if (spec.seriesFields) {
		if (spec.seriesFields.length > MAX_DATASETS) {
			throw validationError(`Too many datasets: ${spec.seriesFields.length}. Limit is ${MAX_DATASETS}.`, rows);
		}
		datasets = spec.seriesFields.map((field, index) => ({
			label: spec.labels?.[field] || field,
			data: labels.map((label) => {
				const matchingRows = rows.filter((row) => String(row[spec.x]) === label);
				if (matchingRows.length === 0) return missingValue;
				return getPointValue(matchingRows, field, spec.aggregate, allowNullValues) ?? missingValue;
			}),
			...datasetStyle(index, spec.type, palette),
		}));
	} else if (spec.series) {
		const seriesValues = uniqueByString(
			rows.map((row) => row[spec.series as string]),
			spec.sortSeries ?? false,
		);
		if (seriesValues.length > MAX_DATASETS) {
			throw validationError(`Too many datasets: ${seriesValues.length}. Limit is ${MAX_DATASETS}.`, rows);
		}
		datasets = seriesValues.map((seriesName, index) => ({
			label: spec.labels?.[seriesName] || seriesName,
			data: labels.map((label) => {
				const matchingRows = rows.filter(
					(row) => String(row[spec.x]) === label && String(row[spec.series as string]) === seriesName,
				);
				if (matchingRows.length === 0) return missingValue;
				return getPointValue(matchingRows, spec.y as string, spec.aggregate, allowNullValues) ?? missingValue;
			}),
			...datasetStyle(index, spec.type, palette),
		}));
	} else {
		datasets = [
			{
				label: spec.labels?.[spec.y as string] || (spec.y as string),
				data: labels.map((label) => {
					const matchingRows = rows.filter((row) => String(row[spec.x]) === label);
					if (matchingRows.length === 0) return missingValue;
					return getPointValue(matchingRows, spec.y as string, spec.aggregate, allowNullValues) ?? missingValue;
				}),
				...datasetStyle(0, spec.type, palette),
			},
		];
	}

	const xAxisLabel = spec.xLabel || spec.labels?.[spec.x] || humanizeFieldName(spec.x, "X");
	const yAxisLabel = spec.yLabel || spec.labels?.[spec.y as string] || humanizeFieldName(spec.y, "Value");

	return {
		type: spec.type,
		data: { labels, datasets },
		options: {
			responsive: false,
			animation: false,
			layout: { padding: { top: spec.dataLabels === false ? 8 : 24, right: 12, bottom: 4, left: 4 } },
			plugins: {
				title: { display: Boolean(spec.title), text: spec.title, color: "#111827" },
				legend: {
					display: datasets.length > 1,
					position: spec.legendPosition || "bottom",
					labels: { color: "#111827" },
				},
				...({ fabeeValueLabels: { display: spec.dataLabels !== false } } as Record<string, unknown>),
			},
			scales: {
				y: {
					beginAtZero: true,
					stacked: Boolean(spec.stacked),
					ticks: { color: "#111827" },
					grid: { color: "#e5e7eb" },
					title: { display: true, text: yAxisLabel, color: "#111827" },
				},
				x: {
					stacked: Boolean(spec.stacked),
					ticks: { color: "#111827" },
					grid: { color: "#f3f4f6" },
					title: { display: true, text: xAxisLabel, color: "#111827" },
				},
			},
		},
	};
}

export function buildPieChartConfigFromRows(rows: Row[], rawSpec: unknown): ChartConfiguration {
	if (!isRecord(rawSpec)) throw validationError("pieSpec is required and must be an object.", rows);
	const spec = rawSpec as unknown as PieSpec;
	if (spec.type !== "pie" && spec.type !== "doughnut") {
		throw validationError(`Unsupported pie type "${String(spec.type)}". Supported: pie, doughnut.`, rows);
	}
	const categoryField = spec.category || spec.label;
	const valueField = spec.y || spec.value;
	assertField(rows, categoryField, "category/label");
	assertField(rows, valueField, "value/y");
	assertAggregate(spec.aggregate, rows);
	const palette = assertPalette(spec.palette, rows);
	const categories = uniqueByString(rows.map((row) => row[categoryField]));
	if (categories.length > MAX_LABELS)
		throw validationError(`Too many slices: ${categories.length}. Limit is ${MAX_LABELS}.`, rows);
	const slices = categories.map((category) => {
		const matchingRows = rows.filter((row) => String(row[categoryField]) === category);
		const value = getPointValue(matchingRows, valueField, spec.aggregate, false);
		if (value === null) throw validationError(`Pie value for category "${category}" is null.`, rows);
		if (value < 0)
			throw validationError(`Pie/doughnut values must not be negative. Category "${category}" has ${value}.`, rows);
		return { label: category, value };
	});

	let renderedSlices = slices;
	if (spec.maxSlices !== undefined && slices.length > spec.maxSlices) {
		if (!spec.groupOthers) {
			throw validationError(
				`Too many slices: ${slices.length} exceeds maxSlices ${spec.maxSlices}. Set groupOthers: true to combine the tail.`,
				rows,
			);
		}
		const keepCount = Math.max(1, spec.maxSlices - 1);
		const kept = slices.slice(0, keepCount);
		const otherValue = slices.slice(keepCount).reduce((sum, slice) => sum + slice.value, 0);
		renderedSlices = [...kept, { label: spec.otherLabel || "Other", value: otherValue }];
	}

	return {
		type: spec.type,
		data: {
			labels: renderedSlices.map((slice) => slice.label),
			datasets: [
				{
					label: valueField,
					data: renderedSlices.map((slice) => slice.value),
					backgroundColor: renderedSlices.map((_, index) => `${palette[index % palette.length]}cc`),
					borderColor: renderedSlices.map((_, index) => palette[index % palette.length]),
				},
			],
		},
		options: {
			responsive: false,
			animation: false,
			layout: { padding: 12 },
			plugins: {
				title: { display: Boolean(spec.title), text: spec.title, color: "#111827" },
				legend: { display: true, position: spec.legendPosition || "right", labels: { color: "#111827" } },
				...({ fabeeValueLabels: { display: spec.dataLabels !== false } } as Record<string, unknown>),
			},
		},
	};
}

export function renderChartConfigToPng(config: ChartConfiguration, width: number, height: number): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	const chartConfig: ChartConfiguration = {
		...config,
		plugins: [whiteBackgroundPlugin, valueLabelsPlugin, ...(config.plugins || [])],
	};
	const chart = new Chart(context as never, chartConfig);
	chart.update();
	const buffer = canvas.toBuffer("image/png");
	chart.destroy();
	if (buffer.subarray(0, 8).toString("hex") !== PNG_MAGIC) {
		throw new Error("Chart renderer did not produce a valid PNG buffer");
	}
	return buffer;
}

function getChartMaxPngBytes(): number {
	const raw = process.env.BEE_PI_AGENT_CHART_MAX_PNG_BYTES;
	if (!raw) return DEFAULT_MAX_PNG_BYTES;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PNG_BYTES;
}

function normalizeDimension(value: number | undefined, defaultValue: number, maxValue: number, label: string): number {
	if (value === undefined) return defaultValue;
	if (!Number.isFinite(value) || value <= 0 || value > maxValue) {
		throw new Error(`Invalid chart ${label}: ${value}. Must be > 0 and <= ${maxValue}.`);
	}
	return Math.round(value);
}

function sanitizeOutputName(value: string | undefined, title: string | undefined): string {
	const base = value || title || "chart.png";
	const parsed = basename(base)
		.replace(/[^a-zA-Z0-9._-]/g, "_")
		.replace(/^\.+/, "");
	const fallback = parsed.length > 0 ? parsed : "chart.png";
	return extname(fallback).toLowerCase() === ".png" ? fallback : `${fallback}.png`;
}

async function readRowsFromJsonPath(inputPath: string): Promise<Row[]> {
	if (extname(inputPath).toLowerCase() !== ".json") {
		throw new Error(`Chart inputPath must point to a .json file. Received: ${inputPath}`);
	}
	if (!existsSync(inputPath)) {
		throw new Error(`Chart input file does not exist: ${inputPath}`);
	}
	const details = await stat(inputPath);
	if (details.size > MAX_INPUT_BYTES) {
		throw new Error(
			`Chart input file is too large: ${details.size} bytes. Limit is ${MAX_INPUT_BYTES} bytes. Path: ${inputPath}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(inputPath, "utf-8"));
	} catch (error) {
		throw new Error(
			`Chart input file is not parseable JSON: ${inputPath}. ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return normalizeRows(parsed);
}

export function createChartTool(artifactHandler: ArtifactHandler, sessionDir: string): AgentTool<typeof chartSchema> {
	return {
		name: "chart",
		label: "chart",
		description:
			"Render a deterministic PNG chart from a clean JSON file (normally dbt show { show: [...] }) and register it as an image/png artifact. Does not guess columns; provide chartSpec or pieSpec explicitly.",
		parameters: chartSchema,
		execute: async (
			_toolCallId: string,
			{
				inputPath,
				chartSpec,
				pieSpec,
				outputName,
				title,
				width,
				height,
			}: {
				label: string;
				inputPath: string;
				chartSpec?: unknown;
				pieSpec?: unknown;
				outputName?: string;
				title?: string;
				width?: number;
				height?: number;
			},
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (Boolean(chartSpec) === Boolean(pieSpec)) {
				throw new Error("Exactly one of chartSpec or pieSpec must be provided.");
			}
			const rows = await readRowsFromJsonPath(inputPath);
			const renderedWidth = normalizeDimension(width, DEFAULT_WIDTH, MAX_WIDTH, "width");
			const renderedHeight = normalizeDimension(height, DEFAULT_HEIGHT, MAX_HEIGHT, "height");
			const config = chartSpec
				? buildChartConfigFromRows(rows, chartSpec)
				: buildPieChartConfigFromRows(rows, pieSpec);
			const buffer = renderChartConfigToPng(config, renderedWidth, renderedHeight);
			const maxPngBytes = getChartMaxPngBytes();
			if (buffer.length > maxPngBytes) {
				throw new Error(
					`Rendered PNG is ${buffer.length} bytes, exceeding chart inline-safe limit ${maxPngBytes} bytes. Reduce dimensions, aggregate data further, or wait for large artifact object storage support.`,
				);
			}
			const artifactName = sanitizeOutputName(
				outputName,
				title || (chartSpec as ChartSpec | undefined)?.title || (pieSpec as PieSpec | undefined)?.title,
			);
			const outputPath = join(sessionDir, "outputs", "charts", artifactName);
			await mkdir(dirname(outputPath), { recursive: true });
			await writeFile(outputPath, buffer);
			await artifactHandler({
				path: outputPath,
				name: artifactName,
				title: title || artifactName,
				mimeType: "image/png",
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Rendered chart artifact ${artifactName} (${buffer.length} bytes, ${renderedWidth}x${renderedHeight}) from ${rows.length} rows.`,
					},
				],
				details: {
					inputPath,
					outputPath,
					artifactName,
					mimeType: "image/png",
					rowCount: rows.length,
					width: renderedWidth,
					height: renderedHeight,
					sizeBytes: buffer.length,
				},
			};
		},
	};
}
