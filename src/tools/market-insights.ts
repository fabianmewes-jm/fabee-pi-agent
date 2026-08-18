import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

export const MARKET_INSIGHTS_TOOL_NAME = "market_insights";
export const DEFAULT_RADIUS_KM = 50;
const SCHEMA_ID = "de.jobmatchme.matching.entity-facets";
const SNAPSHOT_FILE = "market-insights-entity-facets.json";
const RADIUS_SOURCE = "matching-service/src/main/scala/de/jobmatchme/matching/algorithm/ContractComposedMatching.scala";

type FilterType = "BOOLEAN" | "STRING" | "NUMBER";
type RadiusRule = number | "truck.dynamic";
export interface MarketInsightsContract {
	schemaId: string;
	schemaVersion: string;
	contractVersion: number;
	markets: string[];
	filterTypes: Record<string, FilterType>;
	radiusRules: Record<string, RadiusRule>;
	raw: unknown;
}
interface Runtime {
	baseUrl: string;
	token: string;
	contract: MarketInsightsContract;
	fetch: typeof fetch;
	nominatimUrl: string;
}
let startupRuntime: Runtime | undefined;

const radiusKm = Type.Optional(
	Type.Number({
		exclusiveMinimum: 0,
		maximum: 500,
		description:
			"Set only when the user explicitly states a radius. Otherwise omit radiusKm so the tool applies the entity-facets contract rule, then its 50 km fallback only when no contract rule exists.",
	}),
);
const geoSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("geo_radius"),
			lat: Type.Number({ minimum: -90, maximum: 90 }),
			lon: Type.Number({ minimum: -180, maximum: 180 }),
			radiusKm,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("geo_radius"),
			location: Type.String({ minLength: 1, maxLength: 300 }),
			radiusKm,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("geo_county"), county_name: Type.String({ minLength: 1, maxLength: 300 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("geo_state"), state_name: Type.String({ minLength: 1, maxLength: 300 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("geo_country"), country_name: Type.String({ minLength: 1, maxLength: 300 }) },
		{ additionalProperties: false },
	),
]);
function createSchema(contract: MarketInsightsContract) {
	const filters = Object.fromEntries(
		Object.entries(contract.filterTypes).map(([key, type]) => [
			key,
			Type.Optional(
				type === "BOOLEAN"
					? Type.Boolean()
					: type === "STRING"
						? Type.Union([
								Type.Object({ eq: Type.String() }, { additionalProperties: false }),
								Type.Object({ contains: Type.String() }, { additionalProperties: false }),
							])
						: Type.Union([
								Type.Object({ eq: Type.Number() }, { additionalProperties: false }),
								Type.Object({ gt: Type.Number() }, { additionalProperties: false }),
								Type.Object({ lt: Type.Number() }, { additionalProperties: false }),
							]),
			),
		]),
	);
	return Type.Object(
		{
			label: Type.String({ maxLength: 300 }),
			slices: Type.Array(
				Type.Object(
					{
						market: Type.Union(
							contract.markets.map((market) => Type.Literal(market)),
							{
								description: `Supported salary markets: ${contract.markets.join(", ")}.`,
							},
						),
						geo: Type.Optional(geoSchema),
						filters: Type.Optional(
							Type.Object(filters, {
								additionalProperties: false,
								description:
									"Only the listed projection filters are supported. BOOLEAN uses true/false; STRING uses { eq: string } or { contains: string }; NUMBER uses { eq: number }, { gt: number }, or { lt: number }.",
							}),
						),
						timeframe: Type.Optional(
							Type.Object(
								{ start: Type.Optional(Type.String()), end: Type.Optional(Type.String()) },
								{ additionalProperties: false },
							),
						),
					},
					{ additionalProperties: false },
				),
				{ minItems: 1, maxItems: 20 },
			),
		},
		{ additionalProperties: false },
	);
}

function env(...names: string[]): string | undefined {
	return names.map((name) => process.env[name]).find((value) => value?.trim());
}
export function isMarketInsightsConfigured(): boolean {
	return Boolean(
		env(
			"BEE_PI_AGENT_MARKET_INSIGHTS_BASE_URL",
			"PI_AGENT_WORKER_MARKET_INSIGHTS_BASE_URL",
			"BEE_PI_AGENT_MARKET_INSIGHTS_TOKEN",
			"PI_AGENT_WORKER_MARKET_INSIGHTS_TOKEN",
		),
	);
}

/** Called before the worker socket starts. The contract is never downloaded per turn/run. */
export async function initializeMarketInsights(args: {
	baseUrl: string;
	token: string;
	stateDir: string;
	contractUrl?: string;
	fetch?: typeof fetch;
	nominatimUrl?: string;
}): Promise<void> {
	const fetchImpl = args.fetch || fetch;
	const contract = await loadMarketInsightsContract({ ...args, fetch: fetchImpl });
	startupRuntime = {
		baseUrl: args.baseUrl,
		token: args.token,
		contract,
		fetch: fetchImpl,
		nominatimUrl:
			args.nominatimUrl || env("BEE_PI_AGENT_NOMINATIM_URL") || "https://nominatim.openstreetmap.org/search",
	};
	console.info(
		`Market Insights contract snapshot ready: contractVersion=${contract.contractVersion} schemaVersion=${contract.schemaVersion}`,
	);
}

export async function initializeMarketInsightsFromEnv(stateDir: string): Promise<void> {
	if (!isMarketInsightsConfigured()) return;
	const baseUrl = env("BEE_PI_AGENT_MARKET_INSIGHTS_BASE_URL", "PI_AGENT_WORKER_MARKET_INSIGHTS_BASE_URL");
	const token = env("BEE_PI_AGENT_MARKET_INSIGHTS_TOKEN", "PI_AGENT_WORKER_MARKET_INSIGHTS_TOKEN");
	if (!baseUrl || !token) throw new Error("Market Insights requires both base URL and token.");
	await initializeMarketInsights({
		baseUrl,
		token,
		stateDir,
		contractUrl: env("BEE_PI_AGENT_MARKET_INSIGHTS_CONTRACT_URL", "PI_AGENT_WORKER_MARKET_INSIGHTS_CONTRACT_URL"),
	});
}

export async function loadMarketInsightsContract(args: {
	baseUrl: string;
	token: string;
	stateDir: string;
	contractUrl?: string;
	fetch?: typeof fetch;
}): Promise<MarketInsightsContract> {
	const url = args.contractUrl ? new URL(args.contractUrl) : new URL("/internal/entity-facets", args.baseUrl);
	const response = await (args.fetch || fetch)(url, { headers: { Authorization: `Bearer ${args.token}` } });
	if (!response.ok) throw new Error(`Market Insights contract startup fetch failed (HTTP ${response.status}).`);
	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		throw new Error("Market Insights contract startup response was not valid JSON.");
	}
	const contract = parseContract(raw);
	await mkdir(args.stateDir, { recursive: true });
	await writeFile(join(args.stateDir, SNAPSHOT_FILE), JSON.stringify(raw), { mode: 0o600 });
	return contract;
}

export function parseContract(raw: unknown): MarketInsightsContract {
	if (!raw || typeof raw !== "object") throw new Error("Invalid Market Insights entity-facets contract.");
	const value = raw as Record<string, any>;
	if (
		value.schemaId !== SCHEMA_ID ||
		typeof value.schemaVersion !== "string" ||
		!value.schemaVersion ||
		!Number.isInteger(value.contractVersion)
	)
		throw new Error("Invalid entity-facets schemaId, schemaVersion, or contractVersion.");
	if (
		!Array.isArray(value.marketInsightsProfiles) ||
		!value.marketInsightsProjection ||
		!Array.isArray(value.marketInsightsProjection.filters) ||
		!Array.isArray(value.entities)
	)
		throw new Error("Entity-facets contract lacks Market Insights profiles, projection, or entities.");
	const attributes = new Map<string, string>();
	for (const entity of value.entities) {
		if (!entity || !Array.isArray(entity.attributes)) continue;
		for (const attribute of entity.attributes) {
			if (typeof attribute?.key !== "string") continue;
			const previous = attributes.get(attribute.key);
			if (previous !== undefined && previous !== attribute.valueType)
				throw new Error(`Conflicting entity-facets value types for ${attribute.key}.`);
			attributes.set(attribute.key, attribute.valueType);
		}
	}
	const filterTypes: Record<string, FilterType> = {};
	for (const filter of value.marketInsightsProjection.filters) {
		if (!filter || typeof filter.key !== "string")
			throw new Error("Invalid Market Insights filter projection entry.");
		const type = attributes.get(filter.key)?.toUpperCase();
		if (type !== "BOOLEAN" && type !== "STRING" && type !== "NUMBER")
			throw new Error(`Invalid Market Insights filter projection: ${filter.key}`);
		filterTypes[filter.key] = type;
	}
	const markets = value.marketInsightsProfiles
		.map((profile: any) => profile?.id)
		.filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
	if (!markets.length || new Set(markets).size !== markets.length)
		throw new Error("Entity-facets contract has invalid Market Insights markets.");
	return {
		schemaId: value.schemaId,
		schemaVersion: value.schemaVersion,
		contractVersion: value.contractVersion,
		markets,
		filterTypes,
		radiusRules: deriveRadiusRules(markets, value.matchingMethods),
		raw,
	};
}

function deriveRadiusRules(markets: string[], matchingMethods: unknown): Record<string, RadiusRule> {
	if (!Array.isArray(matchingMethods)) return {};
	const rules: Record<string, RadiusRule> = {};
	for (const market of markets) {
		const prefixes = market === "healthcare" ? ["healthcare", "care"] : [market];
		const methods = matchingMethods.filter(
			(method: any) =>
				typeof method?.id === "string" &&
				prefixes.some((prefix) => method.id.startsWith(`${prefix}_`)) &&
				method.targetEntityType === "jobsearch",
		);
		const candidates = methods
			.flatMap((method: any) => method.hardFilters || [])
			.filter(
				(filter: any) =>
					filter?.id === "geo.distanceFilter" || filter?.operatorId === "matcher.geo.distanceFilter.v1",
			)
			.map((filter: any) => filter?.parameters?.radiusKm);
		const values = [
			...new Set(
				candidates.filter((candidate: unknown) => typeof candidate === "string" || typeof candidate === "number"),
			),
		];
		if (values.length > 1) throw new Error(`Conflicting radius rules for market ${market}.`);
		if (values.length === 1) {
			const raw = values[0];
			if (raw === "truck.dynamic") rules[market] = raw;
			else {
				const numeric = Number(raw);
				if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`Invalid radius rule for market ${market}.`);
				rules[market] = numeric;
			}
		}
	}
	return rules;
}

export function truckDynamicRadius(filters: Record<string, unknown>): number {
	const regional = filters["task.transportDistance.regional"] === true;
	const national = filters["task.transportDistance.national"] === true;
	const international = filters["task.transportDistance.international"] === true;
	if (international && national && regional) return 150;
	if (international && national) return 130;
	if (international && regional) return 100;
	if (national && regional) return 60;
	if (international) return 150;
	if (national) return 90;
	if (regional) return 40;
	return 100; // leading Scala implementation's no-distance fallback
}

function validateFilters(filters: Record<string, unknown>, contract: MarketInsightsContract): void {
	for (const [key, value] of Object.entries(filters)) {
		const type = contract.filterTypes[key];
		if (!type) {
			if (key === "joboffer_id")
				throw new Error(
					"joboffer_id is not supported by the salary Market Insights projection. This tool aggregates market salary data and cannot query an individual job offer.",
				);
			throw new Error(`Unsupported salary Market Insights projection filter: ${key}.`);
		}
		if (type === "BOOLEAN" && typeof value !== "boolean") throw new Error(`Filter ${key} must be boolean.`);
		if (type === "STRING" && !operatorValue(value, ["eq", "contains"], "string"))
			throw new Error(`Filter ${key} requires { eq: string } or { contains: string }.`);
		if (type === "NUMBER" && !operatorValue(value, ["eq", "gt", "lt"], "number"))
			throw new Error(`Filter ${key} requires { eq: number }, { gt: number }, or { lt: number }.`);
	}
}
function describeContract(contract: MarketInsightsContract): string {
	const filters = Object.entries(contract.filterTypes)
		.map(([key, type]) => `${key} (${type})`)
		.join(", ");
	return [
		"Query aggregated salary statistics through the POST salary Market Insights route; this is not reverse matching or candidate matching.",
		`Supported salary markets: ${contract.markets.join(", ")}.`,
		`Supported projection filters: ${filters || "none"}. BOOLEAN uses true/false; STRING uses { eq: string } or { contains: string }; NUMBER uses { eq: number }, { gt: number }, or { lt: number }.`,
		"Use exactly one geo form per slice: geo_radius (coordinates or one geocoded location, optionally radiusKm), geo_county, geo_state, or geo_country. Do not combine location with coordinates. Set radiusKm only when the user explicitly states a radius; otherwise omit it so this tool applies the entity-facets contract rule and only then its 50 km fallback.",
		"joboffer_id is not a supported projection filter because this tool does not query individual job offers.",
	].join(" ");
}
function operatorValue(value: unknown, operators: string[], valueType: string): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entries = Object.entries(value);
	return (
		entries.length === 1 &&
		operators.includes(entries[0][0]) &&
		typeof entries[0][1] === valueType &&
		(valueType !== "number" || Number.isFinite(entries[0][1]))
	);
}
function validateTimeframe(timeframe: { start?: string; end?: string } | undefined): void {
	for (const [name, value] of Object.entries(timeframe || {}))
		if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value))
			throw new Error(`Timeframe ${name} must be YYYY-MM-DD.`);
}

async function normalizeGeo(
	geo: any,
	market: string,
	filters: Record<string, unknown>,
	runtime: Runtime,
	signal?: AbortSignal,
): Promise<{ value: unknown; assumption?: string }> {
	if (!geo)
		return { value: { type: "geo_country", country_name: "Germany" }, assumption: "Geography defaulted to Germany" };
	if (geo.type !== "geo_radius") return { value: geo };
	let { lat, lon } = geo;
	if ((lat === undefined) !== (lon === undefined))
		throw new Error("Radius latitude and longitude must be supplied together.");
	if (geo.location) {
		if (lat !== undefined) throw new Error("Use location or direct coordinates, not both.");
		const url = new URL(runtime.nominatimUrl);
		url.searchParams.set("q", geo.location);
		url.searchParams.set("format", "jsonv2");
		url.searchParams.set("limit", "10");
		url.searchParams.set("countrycodes", "de");
		url.searchParams.set("accept-language", "de");
		const response = await runtime.fetch(url, {
			headers: { "User-Agent": "fabee-pi-agent/market-insights" },
			signal,
		});
		if (!response.ok) throw new Error(`Nominatim failed (HTTP ${response.status}).`);
		const results = (await response.json()) as Array<{ lat?: string; lon?: string }>;
		if (!Array.isArray(results) || results.length !== 1)
			throw new Error("Nominatim location is missing or ambiguous; provide coordinates or a more specific place.");
		lat = Number(results[0].lat);
		lon = Number(results[0].lon);
	}
	if (!Number.isFinite(lat) || !Number.isFinite(lon))
		throw new Error("A radius query requires coordinates or one unambiguous location.");
	const rule = runtime.contract.radiusRules[market];
	const radius = geo.radiusKm ?? (rule === "truck.dynamic" ? truckDynamicRadius(filters) : rule) ?? DEFAULT_RADIUS_KM;
	return {
		value: { type: "geo_radius", lat, lon, radius_km: radius },
		assumption:
			geo.radiusKm === undefined
				? `Radius defaulted from ${rule === undefined ? "Market Insights" : "entity-facets contract"} to ${radius} km`
				: undefined,
	};
}

function safeApiError(body: string, token: string): string {
	return body
		.replaceAll(token, "[REDACTED]")
		.replaceAll(/[\r\n\t]+/g, " ")
		.trim()
		.slice(0, 500);
}

function validateApiResult(value: unknown): {
	results: Array<{
		geo?: unknown;
		filters?: unknown;
		timeframe?: unknown;
		statistics: { sampleSize: number; p25: number; median: number; p75: number; mean: number };
	}>;
} {
	if (!value || typeof value !== "object" || !Array.isArray((value as any).results))
		throw new Error("Market Insights API returned an invalid result shape.");
	for (const result of (value as any).results) {
		const stats = result?.statistics;
		if (
			!stats ||
			!Number.isInteger(stats.sampleSize) ||
			![stats.p25, stats.median, stats.p75, stats.mean].every(Number.isFinite)
		)
			throw new Error("Market Insights API returned invalid salary statistics.");
	}
	return value as any;
}

const MAX_MODEL_RESULT_CHARS = 30_000;

function modelVisibleSliceJson(slices: any[]): string {
	const full = JSON.stringify(slices);
	if (full.length <= MAX_MODEL_RESULT_CHARS) return full;
	const compact = slices.map((slice) => {
		const entries = Object.entries(slice.filters || {});
		return {
			...slice,
			filters: Object.fromEntries(
				entries.slice(0, 10).map(([key, value]) => {
					const encoded = JSON.stringify(value);
					return [key, encoded.length <= 160 ? value : `${encoded.slice(0, 157)}...`];
				}),
			),
			omittedFilterCount: Math.max(0, entries.length - 10),
		};
	});
	const compactJson = JSON.stringify(compact);
	if (compactJson.length <= MAX_MODEL_RESULT_CHARS) return compactJson;
	const keyOnlyJson = JSON.stringify(
		compact.map((slice) => ({
			...slice,
			filters: Object.keys(slice.filters).slice(0, 10),
		})),
	);
	if (keyOnlyJson.length <= MAX_MODEL_RESULT_CHARS) return keyOnlyJson;
	return JSON.stringify(
		slices.slice(0, 20).map(({ slice, market, sampleSize, p25, median, p75, mean }) => ({
			slice,
			market: String(market).slice(0, 100),
			sampleSize,
			p25,
			median,
			p75,
			mean,
			scopeOmittedFromModelText: true,
		})),
	);
}

export function createMarketInsightsTool(override?: Runtime): AgentTool<any> {
	const runtime = override || startupRuntime;
	if (!runtime) throw new Error("Market Insights startup contract has not been initialized.");
	return {
		name: MARKET_INSIGHTS_TOOL_NAME,
		label: MARKET_INSIGHTS_TOOL_NAME,
		description: describeContract(runtime.contract),
		parameters: createSchema(runtime.contract),
		execute: async (_id, input, signal) => {
			const prepared = await Promise.all(
				(input as any).slices.map(async (slice: any, index: number) => {
					if (!runtime.contract.markets.includes(slice.market))
						throw new Error(
							`Unsupported salary Market Insights market: ${slice.market}. Supported markets: ${runtime.contract.markets.join(", ")}.`,
						);
					const filters = slice.filters || {};
					validateFilters(filters, runtime.contract);
					validateTimeframe(slice.timeframe);
					const geo = await normalizeGeo(slice.geo, slice.market, filters, runtime, signal);
					const assumptions = [
						geo.assumption,
						!slice.timeframe ? "Timeframe defaulted to all available data" : undefined,
						!Object.keys(filters).length ? "No additional filters" : undefined,
					].filter(Boolean);
					return {
						index,
						market: slice.market,
						assumptions,
						apiSlice: {
							geo: geo.value,
							...(Object.keys(filters).length ? { filters } : {}),
							...(slice.timeframe ? { timeframe: slice.timeframe } : {}),
						},
					};
				}),
			);
			const grouped = new Map<string, typeof prepared>();
			for (const item of prepared) grouped.set(item.market, [...(grouped.get(item.market) || []), item]);
			const output: any[] = [];
			for (const [market, items] of grouped) {
				const url = new URL(runtime.baseUrl);
				url.searchParams.set("market", market);
				const response = await runtime.fetch(url, {
					method: "POST",
					headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ slices: items.map((item) => item.apiSlice) }),
					signal,
				});
				if (!response.ok) {
					const message = safeApiError(await response.text(), runtime.token);
					throw new Error(`Market Insights API failed (HTTP ${response.status})${message ? `: ${message}` : "."}`);
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(await response.text());
				} catch {
					throw new Error("Market Insights API returned invalid JSON.");
				}
				const result = validateApiResult(parsed);
				if (result.results.length !== items.length)
					throw new Error("Market Insights API returned a different number of slices.");
				result.results.forEach((entry, position) => {
					output.push({
						...entry,
						index: items[position].index,
						market,
						geo: items[position].apiSlice.geo,
						filters: items[position].apiSlice.filters || {},
						timeframe: items[position].apiSlice.timeframe || "all available data",
						assumptions: items[position].assumptions,
					});
				});
			}
			output.sort((a, b) => a.index - b.index);
			const modelSlices = output.map(({ index, market, geo, filters, timeframe, assumptions, statistics }) => ({
				slice: index + 1,
				market,
				geo,
				filters,
				timeframe,
				assumptions,
				sampleSize: statistics.sampleSize,
				p25: statistics.p25,
				median: statistics.median,
				p75: statistics.p75,
				mean: statistics.mean,
			}));
			return {
				content: [
					{
						type: "text",
						text: `Market Insights salary statistics (entity-facets contract v${runtime.contract.contractVersion}). sampleSize counts Jobsearch projection rows with a complete salary range; it does not establish unique, active, available, or compatible people. last_updated, where present, is technical freshness only. Per-slice scope and results: ${modelVisibleSliceJson(modelSlices)}`,
					},
				],
				details: {
					contractVersion: runtime.contract.contractVersion,
					schemaVersion: runtime.contract.schemaVersion,
					radiusSemanticsSource: RADIUS_SOURCE,
					sampleSizeDefinition:
						"Jobsearch projection rows with a complete salary range; not necessarily unique, active, available, or compatible people.",
					lastUpdatedDefinition: "Technical freshness window only; not activity evidence.",
					slices: output,
				},
			};
		},
	};
}
