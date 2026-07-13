import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createCanvas, GlobalFonts, Image } from "@napi-rs/canvas";
import { Type } from "@sinclair/typebox";
import { Chart, type ChartConfiguration, type Plugin, registerables } from "chart.js";

Chart.register(...registerables);

export const BRAND_COLORS = {
	primary: "#74c4f6",
	secondary: "#fbc44c",
	text: "#2c2a29",
	mutedText: "#756f6c",
	grid: "#2c2a2918",
	background: "#ffffff",
} as const;

export const DEFAULT_PALETTE = [
	BRAND_COLORS.primary,
	BRAND_COLORS.secondary,
	"#23d1a2",
	"#3b9fdd",
	"#d99a05",
	"#167f63",
	"#acdffc",
	"#ffda84",
	"#8de7cf",
	"#1d77b1",
];

const MAX_ROWS = 5000;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_LABELS = 200;
const MAX_DATASETS = 20;
const TEMPLATE_WIDTH = 1920;
const TEMPLATE_HEIGHT = 1080;
const DEFAULT_MAX_PNG_BYTES = 650_000;
const PNG_MAGIC = "89504e470d0a1a0a";
const BRAND_FONT = "Wix Madefor Display";

let brandLogo: Image | undefined;

function ensureBrandAssets(): Image {
	if (brandLogo) return brandLogo;
	const assetUrl = (path: string) => fileURLToPath(new URL(`../../assets/${path}`, import.meta.url));
	for (const file of [
		"fonts/WixMadeforDisplay-Regular.ttf",
		"fonts/WixMadeforDisplay-SemiBold.ttf",
		"fonts/WixMadeforDisplay-Bold.ttf",
	]) {
		if (!GlobalFonts.registerFromPath(assetUrl(file), BRAND_FONT)) {
			throw new Error(`Could not register required chart font asset: ${file}`);
		}
	}
	const logo = new Image();
	logo.src = readFileSync(assetUrl("jm-logo-vector.svg"));
	if (!logo.complete || logo.width === 0 || logo.height === 0) {
		throw new Error("Could not load required JobMatch chart logo asset");
	}
	brandLogo = logo;
	return logo;
}

const chartSchema = Type.Object({
	label: Type.String({ description: "Brief description of the chart to render (shown to user)" }),
	inputPath: Type.String({ description: "Path to a clean .json file containing { show: [...] } dbt rows" }),
	chartSpec: Type.Optional(Type.Any({ description: "Line/bar chart spec" })),
	pieSpec: Type.Optional(Type.Any({ description: "Pie/doughnut chart spec" })),
	outputName: Type.Optional(
		Type.String({ description: "Optional PNG filename. Will be sanitized and forced to .png" }),
	),
	title: Type.Optional(Type.String({ description: "Optional chart title" })),
	width: Type.Optional(Type.Number({ description: "Chart width in pixels; branded template requires 1920" })),
	height: Type.Optional(Type.Number({ description: "Chart height in pixels; branded template requires 1080" })),
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

const valueLabelsPlugin: Plugin = {
	id: "fabeeValueLabels",
	afterDatasetsDraw: (chart) => {
		const pluginOptions = (chart.options.plugins as Record<string, unknown> | undefined)?.fabeeValueLabels as
			| { display?: boolean }
			| undefined;
		if (pluginOptions?.display === false) return;
		const { ctx } = chart;
		ctx.save();
		ctx.fillStyle = BRAND_COLORS.text;
		ctx.font = `600 15px "${BRAND_FONT}"`;
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
				const text = formatChartValue(rawValue);
				const halfWidth = ctx.measureText(text).width / 2;
				const x = Math.min(
					chart.chartArea.right - halfWidth - 4,
					Math.max(chart.chartArea.left + halfWidth + 4, point.x),
				);
				ctx.fillText(text, x, Math.max(chart.chartArea.top + 16, point.y - 8));
			}
		}
		ctx.restore();
	},
};

function datasetStyle(index: number, type: ChartType, palette: string[]) {
	const color = palette[index % palette.length];
	return {
		borderColor: color,
		backgroundColor: color,
		borderWidth: type === "line" ? 3 : 0,
		tension: type === "line" ? 0.35 : undefined,
		spanGaps: type === "line" ? true : undefined,
		pointRadius: type === "line" ? 0 : undefined,
		borderRadius: type === "bar" ? 4 : undefined,
		borderSkipped: type === "bar" ? false : undefined,
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
			layout: { padding: { top: 10, right: 16, bottom: 4, left: 4 } },
			plugins: {
				title: { display: Boolean(spec.title), text: spec.title, color: BRAND_COLORS.text },
				legend: {
					display: datasets.length > 1,
					position: spec.legendPosition || "top",
					align: "start",
					labels: {
						color: BRAND_COLORS.text,
						usePointStyle: true,
						pointStyle: "circle",
						boxWidth: 9,
						boxHeight: 9,
						padding: 22,
						font: { family: BRAND_FONT, size: 15, weight: 600 },
					},
				},
				...({ fabeeValueLabels: { display: spec.dataLabels !== false } } as Record<string, unknown>),
			},
			scales: {
				y: {
					beginAtZero: true,
					stacked: Boolean(spec.stacked),
					border: { display: false },
					ticks: { color: BRAND_COLORS.mutedText, padding: 18, font: { family: BRAND_FONT, size: 14 } },
					grid: { color: BRAND_COLORS.grid, drawTicks: false },
					title: {
						display: true,
						text: yAxisLabel,
						color: BRAND_COLORS.text,
						padding: { bottom: 20 },
						font: { family: BRAND_FONT, size: 16, weight: 600 },
					},
				},
				x: {
					stacked: Boolean(spec.stacked),
					border: { display: false },
					ticks: { color: BRAND_COLORS.mutedText, padding: 10, font: { family: BRAND_FONT, size: 14 } },
					grid: { display: false, drawTicks: false },
					title: {
						display: true,
						text: xAxisLabel,
						color: BRAND_COLORS.text,
						font: { family: BRAND_FONT, size: 16, weight: 600 },
					},
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
					backgroundColor: renderedSlices.map((_, index) => palette[index % palette.length]),
					borderColor: renderedSlices.map((_, index) => palette[index % palette.length]),
				},
			],
		},
		options: {
			responsive: false,
			animation: false,
			layout: { padding: 20 },
			plugins: {
				title: { display: Boolean(spec.title), text: spec.title, color: BRAND_COLORS.text },
				legend: {
					display: true,
					position: spec.legendPosition || "right",
					labels: { color: BRAND_COLORS.text, font: { family: BRAND_FONT, size: 15 } },
				},
				...({ fabeeValueLabels: { display: spec.dataLabels !== false } } as Record<string, unknown>),
			},
		},
	};
}

function configTitle(config: ChartConfiguration): string | undefined {
	const title = (config.options?.plugins as Record<string, unknown> | undefined)?.title as
		| { text?: unknown }
		| undefined;
	return typeof title?.text === "string" ? title.text : undefined;
}

function drawFittedTitle(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, title: string): void {
	let size = 48;
	const maxWidth = 1250;
	while (size > 28) {
		context.font = `700 ${size}px "${BRAND_FONT}"`;
		if (context.measureText(title).width <= maxWidth) break;
		size -= 2;
	}
	context.fillText(title, 92, 63);
}

function drawTemplateLegend(
	context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	datasets: ChartConfiguration["data"]["datasets"],
): void {
	context.font = `600 17px "${BRAND_FONT}"`;
	context.textBaseline = "middle";
	let x = 120;
	let y = 190;
	for (const dataset of datasets) {
		const label = dataset.label || "Series";
		const rawColor = dataset.borderColor || dataset.backgroundColor;
		const color = Array.isArray(rawColor) ? rawColor[0] : rawColor;
		const itemWidth = context.measureText(label).width + 58;
		if (x + itemWidth > 1800) {
			x = 120;
			y += 32;
		}
		context.beginPath();
		context.fillStyle = typeof color === "string" ? color : BRAND_COLORS.primary;
		context.arc(x, y, 7, 0, Math.PI * 2);
		context.fill();
		context.fillStyle = BRAND_COLORS.text;
		context.fillText(label, x + 14, y);
		x += itemWidth;
	}
	context.textBaseline = "top";
}

export function renderChartConfigToPng(
	config: ChartConfiguration,
	width: number,
	height: number,
	title = configTitle(config) || "Chart",
): Buffer {
	if (width !== TEMPLATE_WIDTH || height !== TEMPLATE_HEIGHT) {
		throw new Error(
			`Branded chart template requires ${TEMPLATE_WIDTH}x${TEMPLATE_HEIGHT}px; received ${width}x${height}px.`,
		);
	}
	const logo = ensureBrandAssets();
	Chart.defaults.font.family = BRAND_FONT;
	Chart.defaults.color = BRAND_COLORS.text;

	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = BRAND_COLORS.background;
	context.fillRect(0, 0, width, height);
	context.fillStyle = BRAND_COLORS.text;
	context.textBaseline = "top";
	drawFittedTitle(context, title);

	const logoWidth = 420;
	context.drawImage(logo, width - 92 - logoWidth, 45, logoWidth, (logoWidth * logo.height) / logo.width);

	const chartPlugins = (config.options?.plugins || {}) as Record<string, unknown>;
	const legend = chartPlugins.legend as { display?: boolean; position?: string } | undefined;
	const hasTemplateLegend =
		(config.type === "line" || config.type === "bar") && legend?.display === true && legend.position === "top";
	if (hasTemplateLegend) drawTemplateLegend(context, config.data.datasets);
	const chartTop = hasTemplateLegend ? 220 : 180;
	const chartCanvas = createCanvas(1736, 940 - chartTop);
	const chartContext = chartCanvas.getContext("2d");
	const chartConfig: ChartConfiguration = {
		...config,
		options: {
			...config.options,
			responsive: false,
			animation: false,
			plugins: {
				...chartPlugins,
				title: { ...(chartPlugins.title as object | undefined), display: false },
				...(hasTemplateLegend ? { legend: { ...(legend as object), display: false } } : {}),
			},
		},
		plugins: [valueLabelsPlugin, ...(config.plugins || [])],
	};
	const chart = new Chart(chartContext as never, chartConfig);
	chart.update();
	context.drawImage(chartCanvas, 92, chartTop);
	chart.destroy();

	context.fillStyle = BRAND_COLORS.text;
	context.font = `500 20px "${BRAND_FONT}"`;
	context.textBaseline = "top";
	context.fillText("Proprietary and confidential", 92, 1010);
	context.textAlign = "right";
	context.fillText(`© ${new Date().getFullYear()} JobMatchMe GmbH`, width - 92, 1010);
	context.textAlign = "left";

	const buffer = canvas.toBuffer("image/png");
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

function normalizeTemplateDimension(value: number | undefined, expected: number, label: string): number {
	if (value === undefined) return expected;
	if (!Number.isFinite(value) || Math.round(value) !== expected) {
		throw new Error(`Branded chart template requires ${label} ${expected}px; received ${value}.`);
	}
	return expected;
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

export function createChartTool(sessionDir: string): AgentTool<typeof chartSchema> {
	return {
		name: "chart",
		label: "chart",
		description:
			"Render a deterministic PNG chart from a clean JSON file (normally dbt show { show: [...] }) and write it to disk. Does not send/register attachments; use the attach tool explicitly if the PNG should be sent. Does not guess columns; provide chartSpec or pieSpec explicitly.",
		parameters: chartSchema,
		execute: async (
			_toolCallId: string,
			{
				label,
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
			const renderedWidth = normalizeTemplateDimension(width, TEMPLATE_WIDTH, "width");
			const renderedHeight = normalizeTemplateDimension(height, TEMPLATE_HEIGHT, "height");
			const config = chartSpec
				? buildChartConfigFromRows(rows, chartSpec)
				: buildPieChartConfigFromRows(rows, pieSpec);
			const renderedTitle =
				title || (chartSpec as ChartSpec | undefined)?.title || (pieSpec as PieSpec | undefined)?.title || label;
			const buffer = renderChartConfigToPng(config, renderedWidth, renderedHeight, renderedTitle);
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
			return {
				content: [
					{
						type: "text" as const,
						text: `Rendered chart file ${artifactName} (${buffer.length} bytes, ${renderedWidth}x${renderedHeight}) from ${rows.length} rows. Use attach to send it.`,
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
