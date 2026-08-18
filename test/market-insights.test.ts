import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createMarketInsightsTool,
	initializeMarketInsights,
	loadMarketInsightsContract,
	parseContract,
	truckDynamicRadius,
} from "../src/tools/market-insights.js";

const contract = {
	schemaId: "de.jobmatchme.matching.entity-facets",
	schemaVersion: "v1",
	contractVersion: 7,
	marketInsightsProfiles: [{ id: "truck" }, { id: "scheduler" }],
	marketInsightsProjection: {
		filters: [
			{ key: "license.ce" },
			{ key: "task.transportDistance.regional" },
			{ key: "task.transportDistance.national" },
			{ key: "task.transportDistance.international" },
			{ key: "language" },
			{ key: "years" },
		],
	},
	entities: [
		{
			attributes: [
				{ key: "license.ce", valueType: "BOOLEAN" },
				{ key: "task.transportDistance.regional", valueType: "BOOLEAN" },
				{ key: "task.transportDistance.national", valueType: "BOOLEAN" },
				{ key: "task.transportDistance.international", valueType: "BOOLEAN" },
				{ key: "language", valueType: "STRING" },
				{ key: "years", valueType: "NUMBER" },
			],
		},
	],
	matchingMethods: [
		{
			id: "truck_match_offer",
			targetEntityType: "jobsearch",
			hardFilters: [{ id: "geo.distanceFilter", parameters: { radiusKm: "truck.dynamic" } }],
		},
		{
			id: "scheduler_match_offer",
			targetEntityType: "jobsearch",
			hardFilters: [{ id: "geo.distanceFilter", parameters: { radiusKm: "55" } }],
		},
	],
};
const stats = { sampleSize: 12, p25: 2800, median: 3000, p75: 3300, mean: 3050 };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tempDirs: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "fabee-market-"));
	tempDirs.push(path);
	return path;
}
function runtime(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
	return {
		baseUrl: "https://api.example/api/matching/salary",
		token: "top-secret",
		contract: parseContract(contract),
		fetch,
		nominatimUrl: "https://geo.example/search",
		...overrides,
	} as any;
}

describe("market insights contract startup", () => {
	it("fetches, validates, and persists the contract exactly once", async () => {
		const fetch = vi.fn().mockResolvedValue(response(contract));
		const dir = await stateDir();
		const loaded = await loadMarketInsightsContract({
			baseUrl: "https://api.example/api/matching/salary",
			token: "secret",
			stateDir: dir,
			fetch,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0].toString()).toBe("https://api.example/internal/entity-facets");
		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer secret");
		expect(loaded.radiusRules).toEqual({ truck: "truck.dynamic", scheduler: 55 });
		expect(JSON.parse(await readFile(join(dir, "market-insights-entity-facets.json"), "utf8"))).toMatchObject({
			contractVersion: 7,
		});
	});

	it("fails initialization for unavailable and malformed contracts without exposing the token", async () => {
		const dir = await stateDir();
		for (const fetch of [vi.fn().mockResolvedValue(response({}, 503)), vi.fn().mockResolvedValue(response({}))]) {
			const error = await initializeMarketInsights({
				baseUrl: "https://api.example/salary",
				token: "secret",
				stateDir: dir,
				fetch,
			}).catch((reason) => reason);
			expect(String(error)).not.toContain("secret");
		}
	});

	it("derives filter types and rejects incomplete metadata", () => {
		expect(parseContract(contract).filterTypes).toMatchObject({
			"license.ce": "BOOLEAN",
			language: "STRING",
			years: "NUMBER",
		});
		expect(() => parseContract({ ...contract, schemaVersion: "" })).toThrow("schemaVersion");
		expect(() => parseContract({ ...contract, entities: [] })).toThrow("filter projection");
	});
});

describe("truck dynamic radius (ContractComposedMatching.scala)", () => {
	const key = (regional: boolean, national: boolean, international: boolean) => ({
		"task.transportDistance.regional": regional,
		"task.transportDistance.national": national,
		"task.transportDistance.international": international,
	});
	it.each([
		[true, false, false, 40],
		[false, true, false, 90],
		[false, false, true, 150],
		[true, true, false, 60],
		[true, false, true, 100],
		[false, true, true, 130],
		[true, true, true, 150],
	])("maps regional=%s national=%s international=%s to %i km", (regional, national, international, radius) => {
		expect(truckDynamicRadius(key(regional as boolean, national as boolean, international as boolean))).toBe(radius);
	});
});

describe("market_insights tool", () => {
	it("exposes salary-market semantics and contract-generated parameter unions", () => {
		const tool = createMarketInsightsTool(runtime(vi.fn()));
		expect(tool.description).toContain("POST salary Market Insights route");
		expect(tool.description).toContain("not reverse matching or candidate matching");
		expect(tool.description).toContain("Supported salary markets: truck, scheduler");
		expect(tool.description).toContain("language (STRING)");
		expect(tool.description).toContain("Use exactly one geo form");
		expect(tool.description).toContain("Set radiusKm only when the user explicitly states a radius");
		expect(tool.parameters.properties.slices.items.properties.geo.anyOf[0].properties.radiusKm.description).toContain(
			"only when the user explicitly states a radius",
		);
		expect(tool.parameters.properties.slices.items.properties.geo.anyOf[0].properties.radiusKm.description).toContain(
			"50 km fallback only when no contract rule exists",
		);
		expect(tool.parameters.properties.slices.items.properties.market.anyOf).toHaveLength(2);
		expect(tool.parameters.properties.slices.items.properties.filters.properties.language.anyOf).toHaveLength(2);
	});

	it("supports typed filters, multiple markets, geo forms, defaults, and structured semantics", async () => {
		const fetch = vi.fn().mockImplementation(async (_url, request) => {
			const slices = JSON.parse(request.body).slices;
			return response({ results: slices.map((slice: unknown) => ({ ...(slice as object), statistics: stats })) });
		});
		const tool = createMarketInsightsTool(runtime(fetch));
		const result = await tool.execute("id", {
			label: "comparison",
			slices: [
				{
					market: "truck",
					geo: { type: "geo_radius", lat: 51, lon: 7 },
					filters: {
						"license.ce": true,
						"task.transportDistance.national": true,
						language: { contains: "B" },
						years: { gt: 2 },
					},
				},
				{ market: "scheduler", geo: { type: "geo_state", state_name: "Nordrhein-Westfalen" } },
				{ market: "truck", geo: { type: "geo_county", county_name: "Köln" }, timeframe: { start: "2026-01-01" } },
			],
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls.map((call) => call[0].toString())).toEqual(
			expect.arrayContaining([expect.stringContaining("market=truck"), expect.stringContaining("market=scheduler")]),
		);
		const truckBody = JSON.parse(fetch.mock.calls.find((call) => call[0].toString().includes("truck"))![1].body);
		expect(truckBody.slices[0].geo.radius_km).toBe(90);
		expect(result.details).toMatchObject({
			contractVersion: 7,
			sampleSizeDefinition: expect.stringContaining("complete salary range"),
			lastUpdatedDefinition: expect.stringContaining("not activity"),
		});
		expect(result.details.slices).toHaveLength(3);

		const visible = result.content[0];
		expect(visible.type).toBe("text");
		if (visible.type !== "text") throw new Error("Expected text content.");
		expect(visible.text).toContain('"market":"truck"');
		expect(visible.text).toContain('"geo":{"type":"geo_radius","lat":51,"lon":7,"radius_km":90}');
		expect(visible.text).toContain('"filters":{"license.ce":true');
		expect(visible.text).toContain('"timeframe":"all available data"');
		expect(visible.text).toContain('"sampleSize":12');
		expect(visible.text).toContain('"p25":2800');
		expect(visible.text).toContain('"median":3000');
		expect(visible.text).toContain('"p75":3300');
		expect(visible.text).toContain('"mean":3050');
	});

	it("defaults missing geography to Germany, timeframe to all data, filters to none", async () => {
		const fetch = vi.fn().mockResolvedValue(response({ results: [{ statistics: stats }] }));
		const result = await createMarketInsightsTool(runtime(fetch)).execute("id", {
			label: "default",
			slices: [{ market: "truck" }],
		});
		expect(JSON.parse(fetch.mock.calls[0][1].body).slices[0]).toEqual({
			geo: { type: "geo_country", country_name: "Germany" },
		});
		expect(result.details.slices[0].assumptions).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Germany"),
				expect.stringContaining("all available"),
				"No additional filters",
			]),
		);
	});

	it("uses explicit radius before a numeric contract rule", async () => {
		const fetch = vi.fn().mockResolvedValue(response({ results: [{ statistics: stats }] }));
		await createMarketInsightsTool(runtime(fetch)).execute("id", {
			label: "radius",
			slices: [{ market: "scheduler", geo: { type: "geo_radius", lat: 1, lon: 2, radiusKm: 25 } }],
		});
		expect(JSON.parse(fetch.mock.calls[0][1].body).slices[0].geo.radius_km).toBe(25);
	});

	it("resolves an omitted radius from the contract before the 50 km fallback", async () => {
		const fetch = vi.fn().mockImplementation(async () => response({ results: [{ statistics: stats }] }));
		await createMarketInsightsTool(runtime(fetch)).execute("contract-radius", {
			label: "contract radius",
			slices: [{ market: "scheduler", geo: { type: "geo_radius", lat: 1, lon: 2 } }],
		});
		const withoutRadiusRule = {
			...parseContract(contract),
			radiusRules: {},
		};
		await createMarketInsightsTool(runtime(fetch, { contract: withoutRadiusRule })).execute("fallback-radius", {
			label: "fallback radius",
			slices: [{ market: "scheduler", geo: { type: "geo_radius", lat: 1, lon: 2 } }],
		});
		expect(JSON.parse(fetch.mock.calls[0][1].body).slices[0].geo.radius_km).toBe(55);
		expect(JSON.parse(fetch.mock.calls[1][1].body).slices[0].geo.radius_km).toBe(50);
	});

	it("prioritizes Germany and rejects ambiguous Nominatim results without calling salary API", async () => {
		const fetch = vi.fn().mockResolvedValue(
			response([
				{ lat: "51", lon: "7" },
				{ lat: "52", lon: "8" },
			]),
		);
		const tool = createMarketInsightsTool(runtime(fetch));
		await expect(
			tool.execute("id", {
				label: "geo",
				slices: [{ market: "truck", geo: { type: "geo_radius", location: "Neustadt" } }],
			}),
		).rejects.toThrow("ambiguous");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0].searchParams.get("countrycodes")).toBe("de");
	});

	it("rejects unknown markets, filters, invalid values and dates before API access", async () => {
		const cases: any[] = [
			{ market: "unknown" },
			{ market: "truck", filters: { unknown: true } },
			{ market: "truck", filters: { "license.ce": { eq: true } } },
			{ market: "truck", filters: { language: { eq: 3 } } },
			{ market: "truck", filters: { years: { gt: "two" } } },
			{ market: "truck", timeframe: { start: "yesterday" } },
		];
		for (const slice of cases) {
			const fetch = vi.fn();
			await expect(
				createMarketInsightsTool(runtime(fetch)).execute("id", { label: "bad", slices: [slice] }),
			).rejects.toThrow();
			expect(fetch).not.toHaveBeenCalled();
		}
	});

	it("explains that joboffer_id cannot scope aggregated salary Market Insights", async () => {
		const fetch = vi.fn();
		await expect(
			createMarketInsightsTool(runtime(fetch)).execute("id", {
				label: "job offer",
				slices: [{ market: "truck", filters: { joboffer_id: { eq: "123" } } }],
			}),
		).rejects.toThrow("cannot query an individual job offer");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uses bearer auth but never exposes the token in results or errors", async () => {
		const fetch = vi.fn().mockResolvedValue(response({ error: "top-secret" }, 401));
		const error = await createMarketInsightsTool(runtime(fetch))
			.execute("id", { label: "auth", slices: [{ market: "truck" }] })
			.catch((reason) => reason);
		expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer top-secret");
		expect(String(error)).not.toContain("top-secret");
	});
});
