import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BookingInventoryFreshness,
	type BriefingPeriod,
	buildCompanyContextSql,
	buildJobofferActivityOverviewSql,
	type CompanyBriefing,
	type CompanyBriefingDataAccess,
	type CompanyContext,
	type CompanyContextLookup,
	createCompanyBriefingTool,
	createJobofferActivityOverviewSignal,
	executeCompanyBriefing,
	mapJobofferActivityRows,
	renderCompanyBriefingMarkdown,
	validateCompanyBriefingArgs,
} from "../src/tools/company-briefing.js";
import { createWorkerTools } from "../src/tools/index.js";
import type { WorkerRunRequest } from "../src/types.js";

const COMPANY_ID = "34e014ed-1038-476a-b46a-5c61a0fd8c0b";
const NOW = new Date("2026-06-23T12:00:00.000Z");

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "fabee-company-briefing-test-"));
}

function companyContext(overrides: Partial<CompanyContext> = {}): CompanyContext {
	return {
		companyId: COMPANY_ID,
		companyName: "Acme GmbH",
		hubspotCompanyId: "hs-1",
		lastReachedCallAt: "2026-06-01T08:00:00.000Z",
		notices: [],
		...overrides,
	};
}

function dataAccess(
	overrides: {
		companyLookup?: CompanyContextLookup;
		freshness?: BookingInventoryFreshness;
		rows?: Record<string, unknown>[];
		companyError?: Error;
		freshnessError?: Error;
		rowsError?: Error;
	} = {},
): CompanyBriefingDataAccess {
	return {
		getCompanyContext: vi.fn(async () => {
			if (overrides.companyError) throw overrides.companyError;
			const defaultLookup: CompanyContextLookup = { status: "found", company: companyContext() };
			return overrides.companyLookup || defaultLookup;
		}),
		getBookingInventoryFreshness: vi.fn(async () => {
			if (overrides.freshnessError) throw overrides.freshnessError;
			return overrides.freshness || { maxActiveDate: "2026-06-23" };
		}),
		getJobofferActivityRows: vi.fn(async () => {
			if (overrides.rowsError) throw overrides.rowsError;
			return overrides.rows || [];
		}),
	};
}

function sampleRows(): Record<string, unknown>[] {
	return [
		{
			jobofferId: "job-1",
			title: "Pflegefachkraft",
			currentProduct: "Premium",
			currentProductSince: "2026-06-10T08:00:00+00:00",
			previousProductAssignments: [
				{ product: "Starter", from: "2026-06-01T08:00:00+00:00", to: "2026-06-10T08:00:00+00:00" },
			],
			currentlyActive: true,
			newBewerbungenCount: 6,
			newHiresCount: 1,
			isExpiring: false,
			bookingEndsAt: null,
		},
		{
			jobofferId: "job-2",
			title: "Ausbildung Pflege",
			currentProduct: "Starter",
			currentProductSince: "2026-06-20T08:00:00+00:00",
			previousProductAssignments: [],
			currentlyActive: true,
			newBewerbungenCount: 0,
			newHiresCount: 0,
			isExpiring: true,
			bookingEndsAt: "2026-06-25T08:00:00+00:00",
		},
	];
}

function servicesFor(overrides: Parameters<typeof dataAccess>[0] = {}) {
	return {
		dataAccess: dataAccess(overrides),
		now: () => NOW,
		requestIdFactory: () => "request-1",
	};
}

function toolRequest(): WorkerRunRequest {
	return {
		sessionId: "session-1",
		conversation: { conversationId: "conversation-1" },
		actor: { userId: "user-1" },
		message: { text: "hi" },
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("company_briefing argument validation", () => {
	it("accepts companyId and normalizes it", () => {
		expect(validateCompanyBriefingArgs({ companyId: COMPANY_ID.toUpperCase() })).toEqual({
			companyId: COMPANY_ID,
		});
	});

	it("rejects invalid companyId", () => {
		expect(() => validateCompanyBriefingArgs({ companyId: "acme" })).toThrow(/companyId/);
	});
});

describe("JOBOFFER_ACTIVITY_OVERVIEW query and mapping", () => {
	it("keeps company context SQL limit-free because dbt show appends its own limit", () => {
		const sql = buildCompanyContextSql(COMPANY_ID);

		expect(sql).toContain("{{ ref('90_hubspot__fct_pre_call_agent_brief') }}");
		expect(sql).toContain(`where company_id = '${COMPANY_ID}'`);
		expect(sql).not.toMatch(/\blimit\b/i);
	});

	it("builds the reviewed half-open period SQL without removed V1 fields", () => {
		const sql = buildJobofferActivityOverviewSql(COMPANY_ID, {
			from: "2026-06-01T00:00:00.000Z",
			to: "2026-06-23T12:00:00.000Z",
			basis: "LAST_REACHED_CALL",
			lastReachedCallAt: "2026-06-01T00:00:00.000Z",
		});

		expect(sql).toContain("{{ ref('90_bookings__fct_active_booking_inventory_daily') }}");
		expect(sql).toContain("{{ ref('90_matching__fct_applications') }}");
		expect(sql).toContain("app.applied_at >= p.period_from");
		expect(sql).toContain("app.applied_at < p.period_to");
		expect(sql).toContain("inv.active_from <= p.period_to");
		expect(sql).toContain("ci.booking_cancel_at < p.period_to + interval '7 days'");
		expect(sql).toContain('ci.product as "currentProduct"');
		expect(sql).toContain('ci.active_from as "currentProductSince"');
		expect(sql).not.toContain("wasActiveInPeriod");
		expect(sql).not.toContain("createdInPeriod");
		expect(sql).not.toContain("changedInPeriod");
	});

	it("normalizes schema fields and applies nullability/fallback rules", () => {
		const mapped = mapJobofferActivityRows([
			{
				jobofferId: "job-null-title",
				title: null,
				currentProduct: null,
				currentProductSince: null,
				previousProductAssignments: JSON.stringify([
					{ product: "Starter", from: "2026-05-01T00:00:00+00:00", to: "2026-06-01T00:00:00+00:00" },
				]),
				currentlyActive: "false",
				newBewerbungenCount: "2",
				newHiresCount: null,
				isExpiring: "false",
				bookingEndsAt: "bad timestamp",
			},
		]);

		expect(mapped.joboffers).toEqual([
			{
				jobofferId: "job-null-title",
				title: "job-null-title",
				currentProduct: null,
				currentProductSince: null,
				previousProductAssignments: [
					{
						product: "Starter",
						from: "2026-05-01T00:00:00.000Z",
						to: "2026-06-01T00:00:00.000Z",
					},
				],
				currentlyActive: false,
				newBewerbungenCount: 2,
				newHiresCount: 0,
				isExpiring: false,
				bookingEndsAt: null,
			},
		]);
		expect(mapped.notices.map((notice) => notice.code)).toEqual(
			expect.arrayContaining([
				"JOBOFFER_TITLE_FALLBACK_APPLIED",
				"UNEXPECTED_NULL_JOBOFFER_COUNT",
				"UNEXPECTED_INVALID_JOBOFFER_TIMESTAMP",
			]),
		);
	});

	it("creates one Platform Signal with complete joboffer data", () => {
		const signal = createJobofferActivityOverviewSignal(mapJobofferActivityRows(sampleRows()).joboffers);

		expect(signal).toMatchObject({
			id: "platform.jobofferActivityOverview",
			type: "JOBOFFER_ACTIVITY_OVERVIEW",
			data: { joboffers: expect.any(Array) },
		});
		expect(signal.data.joboffers).toHaveLength(2);
		expect(signal.facts.join("\n")).toContain("6 New Bewerbungen und 1 New Hires");
	});
});

describe("company_briefing execution", () => {
	it("builds a briefing with joboffer activity and stale-inventory warning", async () => {
		const response = await executeCompanyBriefing(
			{ companyId: COMPANY_ID },
			servicesFor({ freshness: { maxActiveDate: "2026-06-22" }, rows: sampleRows() }),
		);

		expect(response.status).toBe("OK_WITH_WARNINGS");
		expect(response.briefing?.platformSignals).toHaveLength(1);
		expect(response.briefing?.platformSignals[0]).toMatchObject({
			type: "JOBOFFER_ACTIVITY_OVERVIEW",
			data: { joboffers: expect.arrayContaining([expect.objectContaining({ jobofferId: "job-1" })]) },
		});
		expect(response.markdown).toContain("# Company Briefing: Acme GmbH");
		expect(response.markdown).toContain("Pflegefachkraft");
		expect(response.notices.map((notice) => notice.code)).toContain("BOOKING_INVENTORY_STALE");
	});

	it("continues with warning output when the BI joboffer query fails", async () => {
		const response = await executeCompanyBriefing(
			{ companyId: COMPANY_ID },
			servicesFor({ rowsError: new Error("timeout") }),
		);

		expect(response.status).toBe("OK_WITH_WARNINGS");
		expect(response.briefing?.platformSignals).toEqual([]);
		expect(response.markdown).toContain("Platform Signals sind nicht verfügbar");
		expect(response.notices.map((notice) => notice.code)).toContain("PLATFORM_SIGNALS_QUERY_FAILED");
	});

	it("treats no active Joboffers in the Briefing Period as an empty signal, not an error", async () => {
		const response = await executeCompanyBriefing({ companyId: COMPANY_ID }, servicesFor({ rows: [] }));

		expect(response.status).toBe("OK");
		expect(response.briefing?.platformSignals[0]).toMatchObject({
			type: "JOBOFFER_ACTIVITY_OVERVIEW",
			data: { joboffers: [] },
		});
		expect(response.markdown).toContain("Keine Joboffers waren in der Briefing Period active");
	});

	it("does not require requesterSlackId", async () => {
		const response = await executeCompanyBriefing({ companyId: COMPANY_ID }, servicesFor({ rows: sampleRows() }));

		expect(response.status).toBe("OK");
		expect(response.markdown).toContain("# Company Briefing: Acme GmbH");
	});

	it("tool output returns Slack-ready Markdown and structured details without BI raw records", async () => {
		const sessionDir = await tempDir();
		const tool = createCompanyBriefingTool({
			executor: { exec: vi.fn(), getWorkspacePath: (path) => path },
			workspaceRoot: sessionDir,
			workingDir: sessionDir,
			sessionDir,
			dataAccess: dataAccess({ rows: sampleRows() }),
			now: () => NOW,
			requestIdFactory: () => "request-1",
		});

		const result = await tool.execute("tool-call", {
			label: "Company Briefing",
			companyId: COMPANY_ID,
		});

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("# Company Briefing") });
		expect(result.details).toMatchObject({
			status: "OK",
			briefing: { platformSignals: [expect.objectContaining({ type: "JOBOFFER_ACTIVITY_OVERVIEW" })] },
		});
		expect(JSON.stringify(result.details)).not.toMatch(/job_name_internal|booking_cancel_at/);
	});
});

describe("company_briefing Markdown rendering", () => {
	it("renders the fixed Slack-ready Markdown structure and compact no-activity grouping", () => {
		const briefingPeriod: BriefingPeriod = {
			from: "2026-06-01T08:00:00.000Z",
			to: "2026-06-23T12:00:00.000Z",
			basis: "LAST_REACHED_CALL",
			lastReachedCallAt: "2026-06-01T08:00:00.000Z",
		};
		const joboffers = mapJobofferActivityRows([
			...sampleRows(),
			{
				jobofferId: "job-3",
				title: "No activity",
				currentProduct: "Starter",
				currentProductSince: "2026-06-20T08:00:00+00:00",
				previousProductAssignments: [],
				currentlyActive: true,
				newBewerbungenCount: 0,
				newHiresCount: 0,
				isExpiring: false,
				bookingEndsAt: null,
			},
		]).joboffers;
		const briefing: CompanyBriefing = {
			companyId: COMPANY_ID,
			companyName: "Acme GmbH",
			briefingPeriod,
			signalInterpretation: { summary: [], themes: [] },
			salesOpportunities: [],
			platformSignals: [createJobofferActivityOverviewSignal(joboffers)],
			crmSignals: [],
			notices: [],
		};

		const markdown = renderCompanyBriefingMarkdown(briefing);

		expect(markdown).toContain("# Company Briefing: Acme GmbH");
		for (const heading of "Briefing Period|Executive Summary|Sales Opportunities|Platform Signals|CRM Signals|Hinweise / Datenlücken".split(
			"|",
		)) {
			expect(markdown).toContain(`## ${heading}`);
		}
		expect(markdown).toContain("1 weitere aktuell active Joboffers ohne New Bewerbungen/New Hires");
	});
});

describe("company_briefing worker-tool registration", () => {
	it("does not expose company_briefing by default", async () => {
		const sessionDir = await tempDir();
		const tools = await createWorkerTools({
			executor: { exec: vi.fn(), getWorkspacePath: (path) => path },
			artifactHandler: vi.fn(),
			request: toolRequest(),
			workspaceRoot: sessionDir,
			workingDir: sessionDir,
			stateDir: sessionDir,
			sessionDir,
		});

		expect(tools.map((tool) => tool.name)).not.toContain("company_briefing");
	});

	it("exposes company_briefing when the optional built-in env gate is enabled", async () => {
		vi.stubEnv("BEE_PI_AGENT_ENABLE_COMPANY_BRIEFING", "true");
		const sessionDir = await tempDir();
		const tools = await createWorkerTools({
			executor: { exec: vi.fn(), getWorkspacePath: (path) => path },
			artifactHandler: vi.fn(),
			request: toolRequest(),
			workspaceRoot: sessionDir,
			workingDir: sessionDir,
			stateDir: sessionDir,
			sessionDir,
		});

		expect(tools.map((tool) => tool.name)).toContain("company_briefing");
	});
});
