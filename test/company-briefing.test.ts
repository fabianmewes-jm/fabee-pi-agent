import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BookingInventoryFreshness,
	type BriefingPeriod,
	buildCompanyContextSql,
	buildCrmActivitySql,
	buildJobofferActivityOverviewSql,
	type CompanyBriefing,
	type CompanyBriefingDataAccess,
	type CompanyContext,
	type CompanyContextLookup,
	createCompanyBriefingTool,
	createCrmActivityOverviewSignal,
	createJobofferActivityOverviewSignal,
	executeCompanyBriefing,
	mapCrmActivityRows,
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
		crmRows?: Record<string, unknown>[];
		companyError?: Error;
		freshnessError?: Error;
		rowsError?: Error;
		crmRowsError?: Error;
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
		getCrmActivityRows: vi.fn(async () => {
			if (overrides.crmRowsError) throw overrides.crmRowsError;
			return overrides.crmRows || [];
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
			wasPaidInPeriod: true,
			wasFreemiumInPeriod: false,
			newBewerbungenCount: 6,
			newPaidBewerbungenCount: 6,
			newFreemiumBewerbungenCount: 0,
			newOtherBewerbungenCount: 0,
			newHiresCount: 1,
			newPaidHiresCount: 1,
			newFreemiumHiresCount: 0,
			newOtherHiresCount: 0,
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
			wasPaidInPeriod: true,
			wasFreemiumInPeriod: false,
			newBewerbungenCount: 0,
			newPaidBewerbungenCount: 0,
			newFreemiumBewerbungenCount: 0,
			newOtherBewerbungenCount: 0,
			newHiresCount: 0,
			newPaidHiresCount: 0,
			newFreemiumHiresCount: 0,
			newOtherHiresCount: 0,
			isExpiring: true,
			bookingEndsAt: "2026-06-25T08:00:00+00:00",
		},
	];
}

function sampleCrmRows(): Record<string, unknown>[] {
	return [
		{
			objectType: "call",
			objectId: "call-1",
			occurredAt: "2026-06-20T10:00:00+00:00",
			callTitle: "Follow-up Call",
			callDirection: "OUTBOUND",
			callStatus: "COMPLETED",
			callSummary: "Kunde fragt nach Performance der laufenden Jobs.",
			transcriptText: "Sales: Wie läuft es?\nKunde: Wir brauchen mehr Bewerbungen.",
		},
		{
			objectType: "email",
			objectId: "email-1",
			occurredAt: "2026-06-18T09:00:00+00:00",
			emailSubject: "Angebot Verlängerung",
			emailDirection: "OUTGOING_EMAIL",
			emailStatus: "SENT",
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

	it("accepts explicit briefing period dates", () => {
		expect(
			validateCompanyBriefingArgs({ companyId: COMPANY_ID, periodFrom: "2026-06-01", periodTo: "2026-06-23" }),
		).toEqual({
			companyId: COMPANY_ID,
			periodFrom: "2026-06-01T00:00:00.000Z",
			periodTo: "2026-06-23T00:00:00.000Z",
		});
	});

	it("rejects periodTo without periodFrom", () => {
		expect(() => validateCompanyBriefingArgs({ companyId: COMPANY_ID, periodTo: "2026-06-23" })).toThrow(
			/periodFrom/,
		);
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
		expect(sql).toContain('coalesce(ipb.was_paid_in_period, false) as "wasPaidInPeriod"');
		expect(sql).toContain('coalesce(aip.new_paid_bewerbungen_count, 0) as "newPaidBewerbungenCount"');
		expect(sql).not.toContain("wasActiveInPeriod");
		expect(sql).not.toContain("createdInPeriod");
		expect(sql).not.toContain("changedInPeriod");
	});

	it("builds the CRM activity SQL against the materialized company briefing model", () => {
		const sql = buildCrmActivitySql(COMPANY_ID, {
			from: "2026-06-01T00:00:00.000Z",
			to: "2026-06-23T12:00:00.000Z",
			basis: "LAST_REACHED_CALL",
			lastReachedCallAt: "2026-06-01T00:00:00.000Z",
		});

		expect(sql).toContain("{{ ref('90_hubspot__fct_company_briefing_crm_activity') }}");
		expect(sql).toContain(`'${COMPANY_ID}'::text as company_id`);
		expect(sql).toContain("crm.occurred_at >= p.period_from");
		expect(sql).toContain("crm.occurred_at < p.period_to");
		expect(sql).toContain('left(crm.transcript_text, 1000) as "transcriptText"');
	});

	it("normalizes CRM activity rows", () => {
		const mapped = mapCrmActivityRows([
			...sampleCrmRows(),
			{ objectType: "note", objectId: "note-1", occurredAt: "bad", noteBody: "ignored" },
		]);

		expect(mapped.activities).toHaveLength(2);
		expect(mapped.activities[0]).toMatchObject({
			objectType: "call",
			objectId: "call-1",
			occurredAt: "2026-06-20T10:00:00.000Z",
			title: "Follow-up Call",
			detail: expect.stringContaining("Kunde fragt"),
		});
		expect(createCrmActivityOverviewSignal(mapped.activities)).toMatchObject({
			type: "CRM_ACTIVITY_OVERVIEW",
			data: { countsByType: { call: 1, email: 1 } },
		});
		expect(mapped.notices.map((notice) => notice.code)).toContain("UNEXPECTED_INVALID_CRM_ACTIVITY_ROW");
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
				wasPaidInPeriod: false,
				wasFreemiumInPeriod: false,
				newBewerbungenCount: 2,
				newPaidBewerbungenCount: 0,
				newFreemiumBewerbungenCount: 0,
				newOtherBewerbungenCount: 0,
				newHiresCount: 0,
				newPaidHiresCount: 0,
				newFreemiumHiresCount: 0,
				newOtherHiresCount: 0,
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
		expect(signal.facts.join("\n")).toContain("bezahlt 6/1; kostenlos 0/0");
	});
});

describe("company_briefing execution", () => {
	it("builds a briefing with joboffer activity, CRM activity, and stale-inventory warning", async () => {
		const response = await executeCompanyBriefing(
			{ companyId: COMPANY_ID },
			servicesFor({ freshness: { maxActiveDate: "2026-06-22" }, rows: sampleRows(), crmRows: sampleCrmRows() }),
		);

		expect(response.status).toBe("OK_WITH_WARNINGS");
		expect(response.briefing?.platformSignals).toHaveLength(1);
		expect(response.briefing?.platformSignals[0]).toMatchObject({
			type: "JOBOFFER_ACTIVITY_OVERVIEW",
			data: { joboffers: expect.arrayContaining([expect.objectContaining({ jobofferId: "job-1" })]) },
		});
		expect(response.briefing?.crmSignals).toEqual([expect.objectContaining({ type: "CRM_ACTIVITY_OVERVIEW" })]);
		expect(response.markdown).toContain("*Unternehmensbriefing: Acme GmbH*");
		expect(response.markdown).toContain("Pflegefachkraft");
		expect(response.markdown).toContain("*CRM-Aktivitätsübersicht*");
		expect(response.markdown).toContain("Kunde fragt nach Performance");
		expect(response.notices.map((notice) => notice.code)).toContain("BOOKING_INVENTORY_STALE");
	});

	it("continues with warning output when the BI joboffer query fails", async () => {
		const response = await executeCompanyBriefing(
			{ companyId: COMPANY_ID },
			servicesFor({ rowsError: new Error("timeout") }),
		);

		expect(response.status).toBe("OK_WITH_WARNINGS");
		expect(response.briefing?.platformSignals).toEqual([]);
		expect(response.markdown).toContain("Plattformdaten sind nicht verfügbar");
		expect(response.notices.map((notice) => notice.code)).toContain("PLATFORM_SIGNALS_QUERY_FAILED");
	});

	it("treats no active joboffers in the briefing period as an empty signal, not an error", async () => {
		const response = await executeCompanyBriefing({ companyId: COMPANY_ID }, servicesFor({ rows: [] }));

		expect(response.status).toBe("OK");
		expect(response.briefing?.platformSignals[0]).toMatchObject({
			type: "JOBOFFER_ACTIVITY_OVERVIEW",
			data: { joboffers: [] },
		});
		expect(response.markdown).toContain("Keine Stellenanzeigen waren im Zeitraum aktiv");
	});

	it("does not require requesterSlackId", async () => {
		const response = await executeCompanyBriefing({ companyId: COMPANY_ID }, servicesFor({ rows: sampleRows() }));

		expect(response.status).toBe("OK");
		expect(response.markdown).toContain("*Unternehmensbriefing: Acme GmbH*");
	});

	it("falls back to 60 days when the last reached call is older than 180 days", async () => {
		const oldCallAt = "2025-12-01T08:00:00.000Z";
		const fallbackFrom = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
		const access = dataAccess({
			companyLookup: { status: "found", company: companyContext({ lastReachedCallAt: oldCallAt }) },
		});

		const response = await executeCompanyBriefing(
			{ companyId: COMPANY_ID },
			{ dataAccess: access, now: () => NOW, requestIdFactory: () => "request-1" },
		);

		expect(response.status).toBe("OK_WITH_WARNINGS");
		expect(response.briefing?.briefingPeriod).toMatchObject({
			from: fallbackFrom,
			to: NOW.toISOString(),
			basis: "FALLBACK_60_DAYS",
			lastReachedCallAt: null,
		});
		expect(response.notices.map((notice) => notice.code)).toContain("LAST_REACHED_CALL_TOO_OLD");
		expect(response.markdown).toContain("Zeitraum nutzt den 60-Tage-Ersatz");
		expect(access.getJobofferActivityRows).toHaveBeenCalledWith(
			COMPANY_ID,
			expect.objectContaining({ from: fallbackFrom, basis: "FALLBACK_60_DAYS" }),
			undefined,
		);
	});

	it("uses explicit periodFrom and defaults periodTo to now", async () => {
		const access = dataAccess({ rows: sampleRows() });
		const response = await executeCompanyBriefing(
			{ companyId: COMPANY_ID, periodFrom: "2026-06-10T00:00:00.000Z" },
			{ dataAccess: access, now: () => NOW, requestIdFactory: () => "request-1" },
		);

		expect(response.status).toBe("OK");
		expect(response.briefing?.briefingPeriod).toMatchObject({
			from: "2026-06-10T00:00:00.000Z",
			to: NOW.toISOString(),
			basis: "EXPLICIT",
		});
		expect(response.markdown).toContain("expliziter Zeitraum");
		expect(access.getJobofferActivityRows).toHaveBeenCalledWith(
			COMPANY_ID,
			expect.objectContaining({ from: "2026-06-10T00:00:00.000Z", to: NOW.toISOString() }),
			undefined,
		);
	});

	it("blocks invalid explicit periods", async () => {
		const response = await executeCompanyBriefing(
			{
				companyId: COMPANY_ID,
				periodFrom: "2026-06-23T12:00:00.000Z",
				periodTo: "2026-06-23T12:00:00.000Z",
			},
			servicesFor({ rows: sampleRows() }),
		);

		expect(response.status).toBe("FAILED");
		expect(response.notices.map((notice) => notice.code)).toContain("INVALID_BRIEFING_PERIOD");
	});

	it("tool output returns Slack-ready Markdown, structured details, and a CSV artifact", async () => {
		const sessionDir = await tempDir();
		const artifactInputs: unknown[] = [];
		const artifactHandler = vi.fn(async (input: unknown) => {
			artifactInputs.push(input);
		});
		const tool = createCompanyBriefingTool({
			executor: { exec: vi.fn(), getWorkspacePath: (path) => path },
			workspaceRoot: sessionDir,
			workingDir: sessionDir,
			sessionDir,
			dataAccess: dataAccess({ rows: sampleRows() }),
			now: () => NOW,
			requestIdFactory: () => "request-1",
			artifactHandler,
		});

		const result = await tool.execute("tool-call", {
			label: "Unternehmensbriefing",
			companyId: COMPANY_ID,
		});

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("*Unternehmensbriefing") });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("CSV angehängt") });
		expect(artifactHandler).toHaveBeenCalledWith(
			expect.objectContaining({
				name: `company_briefing_${COMPANY_ID}_joboffers.csv`,
				mimeType: "text/csv",
				data: expect.any(Buffer),
			}),
		);
		const artifactInput = artifactInputs[0] as { data: Buffer } | undefined;
		expect(artifactInput).toBeDefined();
		expect(String(artifactInput?.data)).toContain("joboffer_id,title,currently_active");
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
				wasPaidInPeriod: true,
				wasFreemiumInPeriod: false,
				newBewerbungenCount: 0,
				newPaidBewerbungenCount: 0,
				newFreemiumBewerbungenCount: 0,
				newOtherBewerbungenCount: 0,
				newHiresCount: 0,
				newPaidHiresCount: 0,
				newFreemiumHiresCount: 0,
				newOtherHiresCount: 0,
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

		expect(markdown).toContain("*Unternehmensbriefing: Acme GmbH*");
		for (const heading of "Zeitraum|Kurzfassung|Vertriebsansatzpunkte|Plattformdaten|CRM-Daten|Hinweise / Datenlücken".split(
			"|",
		)) {
			expect(markdown).toContain(`*${heading}*`);
		}
		expect(markdown).toContain("1 weitere aktive bezahlte Stellenanzeigen ohne neue Bewerbungen oder Einstellungen");
		expect(markdown).not.toMatch(
			/Company Briefing|Briefing Period|Executive Summary|Sales Opportunities|Platform Signals|CRM Signals|New Hires|New Bewerbungen|active Joboffers/,
		);
	});

	it("summarizes CRM activity instead of rendering a timeline", () => {
		const briefingPeriod: BriefingPeriod = {
			from: "2026-06-01T08:00:00.000Z",
			to: "2026-06-23T12:00:00.000Z",
			basis: "LAST_REACHED_CALL",
			lastReachedCallAt: "2026-06-01T08:00:00.000Z",
		};
		const olderEmails = Array.from({ length: 2 }, (_, index) => ({
			objectType: "email",
			objectId: `older-email-${index + 1}`,
			occurredAt: `2026-06-${String(17 - index).padStart(2, "0")}T09:00:00+00:00`,
			emailSubject: `Older Email ${index + 1}`,
			emailDirection: "OUTGOING_EMAIL",
			emailStatus: "SENT",
		}));
		const activities = mapCrmActivityRows([
			{
				objectType: "email",
				objectId: "latest-email",
				occurredAt: "2026-06-22T09:00:00+00:00",
				emailSubject: "Latest CRM Email",
				emailDirection: "OUTGOING_EMAIL",
				emailStatus: "SENT",
			},
			...sampleCrmRows(),
			...olderEmails,
		]).activities;
		const briefing: CompanyBriefing = {
			companyId: COMPANY_ID,
			companyName: "Acme GmbH",
			briefingPeriod,
			signalInterpretation: { summary: [], themes: [] },
			salesOpportunities: [],
			platformSignals: [],
			crmSignals: [createCrmActivityOverviewSignal(activities)],
			notices: [],
		};

		const markdown = renderCompanyBriefingMarkdown(briefing);

		expect(markdown).toContain("Im Zeitraum wurden 5 CRM-Aktivitäten erfasst.");
		expect(markdown).toContain("Der Schwerpunkt lag auf E-Mail");
		expect(markdown).toContain("CRM-Kontext:");
		expect(markdown).toContain("Kunde fragt nach Performance");
		expect(markdown).not.toContain("Latest CRM Email");
		expect(markdown).not.toContain("Follow-up Call");
		expect(markdown).not.toContain("Letzte Aktivität:");
		expect(markdown).not.toContain("Neueste Aktivität je Typ:");
		expect(markdown).not.toContain("Older Email 1");
		expect(markdown).not.toContain("weitere CRM-Aktivitäten nicht direkt angezeigt");
	});

	it("keeps only the first five active detail rows in the message", () => {
		const briefingPeriod: BriefingPeriod = {
			from: "2026-06-01T08:00:00.000Z",
			to: "2026-06-23T12:00:00.000Z",
			basis: "LAST_REACHED_CALL",
			lastReachedCallAt: "2026-06-01T08:00:00.000Z",
		};
		const rows = Array.from({ length: 7 }, (_, index) => ({
			...sampleRows()[0],
			jobofferId: `job-${index + 1}`,
			title: `Job ${index + 1}`,
		}));
		const briefing: CompanyBriefing = {
			companyId: COMPANY_ID,
			companyName: "Acme GmbH",
			briefingPeriod,
			signalInterpretation: { summary: [], themes: [] },
			salesOpportunities: [],
			platformSignals: [createJobofferActivityOverviewSignal(mapJobofferActivityRows(rows).joboffers)],
			crmSignals: [],
			notices: [],
		};

		const markdown = renderCompanyBriefingMarkdown(briefing);

		expect(markdown).toContain("Job 5");
		expect(markdown).not.toContain("Job 6");
		expect(markdown).toContain(
			"2 weitere Stellenanzeigen mit neuen Bewerbungen, neuen Einstellungen oder auslaufender Buchung werden nur in der CSV gezeigt",
		);
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
