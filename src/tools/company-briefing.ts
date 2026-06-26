import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import type { ArtifactHandler } from "./attach.js";
import { createDbtTool } from "./dbt.js";
import type { WorkerToolExtensionContext } from "./extensions.js";

export const COMPANY_BRIEFING_TOOL_NAME = "company_briefing";
export const JOBOFFER_ACTIVITY_OVERVIEW_TYPE = "JOBOFFER_ACTIVITY_OVERVIEW";
export const CRM_ACTIVITY_OVERVIEW_TYPE = "CRM_ACTIVITY_OVERVIEW";

const COMPANY_ID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const FALLBACK_PERIOD_DAYS = 60;
const MAX_LAST_REACHED_CALL_AGE_DAYS = 180;
const DEFAULT_QUERY_TIMEOUT_SECONDS = 45;
const DEFAULT_QUERY_LIMIT = 1000;
const INLINE_JOBOFFER_DETAIL_LIMIT = 5;
const INLINE_CRM_ACTIVITY_LIMIT = 5;

const companyBriefingSchema = Type.Object(
	{
		label: Type.String({ description: "Brief description of the Company Briefing request (shown to user)" }),
		companyId: Type.String({
			description: "JobMatch Company UUID. Company Briefings must be requested by companyId, not by name.",
			pattern: COMPANY_ID_PATTERN,
		}),
		periodFrom: Type.Optional(
			Type.String({ description: "Optional explicit briefing start timestamp/date, e.g. 2026-06-01 or ISO-8601." }),
		),
		periodTo: Type.Optional(
			Type.String({
				description: "Optional explicit briefing end timestamp/date. Defaults to now when periodFrom is set.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type CompanyBriefingStatus = "OK" | "OK_WITH_WARNINGS" | "BLOCKED" | "FAILED";
export type NoticeSeverity = "INFO" | "WARNING" | "BLOCKING";
export type AffectedBlock = "SALES_OPPORTUNITIES" | "PLATFORM_SIGNALS" | "CRM_SIGNALS" | "SIGNAL_INTERPRETATION";

export interface NoticeItem {
	severity: NoticeSeverity;
	code: string;
	message: string;
	affectedBlock: AffectedBlock;
}

export interface BriefingPeriod {
	from: string;
	to: string;
	basis: "LAST_REACHED_CALL" | "FALLBACK_60_DAYS" | "EXPLICIT";
	lastReachedCallAt: string | null;
}

export interface SignalInterpretation {
	summary: Array<{ text: string; evidenceSignalIds: string[] }>;
	themes: Array<{ label: string; summary: string; evidenceSignalIds: string[] }>;
}

export interface PlatformSignal<TData = unknown> {
	id: string;
	type: string;
	title: string;
	facts: string[];
	data: TData;
}

export interface ProductAssignment {
	product: string;
	from: string;
	to: string;
}

export interface JobofferActivityOverviewItem {
	jobofferId: string;
	title: string;
	currentProduct: string | null;
	currentProductSince: string | null;
	previousProductAssignments: ProductAssignment[];
	currentlyActive: boolean;
	wasPaidInPeriod: boolean;
	wasFreemiumInPeriod: boolean;
	newBewerbungenCount: number;
	newPaidBewerbungenCount: number;
	newFreemiumBewerbungenCount: number;
	newOtherBewerbungenCount: number;
	newHiresCount: number;
	newPaidHiresCount: number;
	newFreemiumHiresCount: number;
	newOtherHiresCount: number;
	isExpiring: boolean;
	bookingEndsAt: string | null;
}

export interface JobofferActivityOverviewData {
	joboffers: JobofferActivityOverviewItem[];
}

export interface CrmSignal<TData = unknown> {
	id: string;
	type: string;
	title: string;
	facts: string[];
	data?: TData;
}

export interface CrmActivityItem {
	objectType: string;
	objectId: string;
	occurredAt: string;
	title: string;
	detail: string | null;
	transcriptExcerpt: string | null;
}

export interface CrmActivityOverviewData {
	activities: CrmActivityItem[];
	countsByType: Record<string, number>;
}

export interface CompanyBriefing {
	companyId: string;
	companyName: string;
	briefingPeriod: BriefingPeriod;
	signalInterpretation: SignalInterpretation;
	salesOpportunities: unknown[];
	platformSignals: PlatformSignal[];
	crmSignals: CrmSignal[];
	notices: NoticeItem[];
}

export interface CompanyBriefingResponse {
	status: CompanyBriefingStatus;
	requestId: string;
	companyId: string;
	briefing: CompanyBriefing | null;
	markdown: string | null;
	notices: NoticeItem[];
}

export interface CompanyContext {
	companyId: string;
	companyName: string;
	hubspotCompanyId: string | null;
	lastReachedCallAt: string | null;
	notices: NoticeItem[];
}

export type CompanyContextLookup =
	| { status: "found"; company: CompanyContext }
	| { status: "not_found" }
	| { status: "not_unique" };

export interface BookingInventoryFreshness {
	maxActiveDate: string | null;
}

export interface CompanyBriefingDataAccess {
	getCompanyContext(companyId: string, signal?: AbortSignal): Promise<CompanyContextLookup>;
	getBookingInventoryFreshness(signal?: AbortSignal): Promise<BookingInventoryFreshness>;
	getJobofferActivityRows(
		companyId: string,
		briefingPeriod: BriefingPeriod,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>[]>;
	getCrmActivityRows(
		companyId: string,
		briefingPeriod: BriefingPeriod,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>[]>;
}

export interface CompanyBriefingServices {
	dataAccess: CompanyBriefingDataAccess;
	now: () => Date;
	requestIdFactory: () => string;
}

export interface CreateCompanyBriefingToolArgs {
	executor: Executor;
	workspaceRoot: string;
	workingDir: string;
	sessionDir: string;
	dataAccess?: CompanyBriefingDataAccess;
	now?: () => Date;
	requestIdFactory?: () => string;
	artifactHandler?: ArtifactHandler;
}

export interface CompanyBriefingToolInput {
	companyId: string;
	periodFrom?: string;
	periodTo?: string;
}

function readEnv(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name];
		if (value) return value;
	}
	return undefined;
}

function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isCompanyBriefingEnvEnabled(): boolean {
	return isTruthyEnv(readEnv("BEE_PI_AGENT_ENABLE_COMPANY_BRIEFING", "PI_AGENT_WORKER_ENABLE_COMPANY_BRIEFING"));
}

function getCompanyBriefingDbtTarget(): string {
	return (
		readEnv(
			"BEE_PI_AGENT_COMPANY_BRIEFING_DBT_TARGET",
			"PI_AGENT_WORKER_COMPANY_BRIEFING_DBT_TARGET",
			"BEE_PI_AGENT_DBT_TARGET",
			"PI_AGENT_WORKER_DBT_TARGET",
		) || "prod"
	);
}

function getCompanyBriefingQueryTimeoutSeconds(): number {
	const raw = readEnv(
		"BEE_PI_AGENT_COMPANY_BRIEFING_QUERY_TIMEOUT_SECONDS",
		"PI_AGENT_WORKER_COMPANY_BRIEFING_QUERY_TIMEOUT_SECONDS",
	);
	if (!raw) return DEFAULT_QUERY_TIMEOUT_SECONDS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUERY_TIMEOUT_SECONDS;
}

function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function getStringValue(row: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = row[key];
		if (value === null || value === undefined) continue;
		const text = String(value).trim();
		if (text.length > 0) return text;
	}
	return null;
}

function getFieldValue(row: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		if (Object.hasOwn(row, key)) return row[key];
	}
	return undefined;
}

function normalizeTimestamp(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	const text = String(value).trim();
	if (!text) return null;
	const normalized = text.includes("T") ? text : text.replace(" ", "T");
	const date = new Date(normalized);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString();
}

function normalizeRequiredTimestamp(
	value: unknown,
	fieldName: string,
	jobofferId: string,
	notices: NoticeItem[],
): string | null {
	const normalized = normalizeTimestamp(value);
	if (!normalized) {
		notices.push(
			platformWarning(
				"UNEXPECTED_NULL_OR_INVALID_JOBOFFER_FIELD",
				`Joboffer ${jobofferId} hat kein gültiges ${fieldName}; der betroffene Product Assignment Eintrag wurde ausgelassen.`,
			),
		);
		return null;
	}
	return normalized;
}

function normalizeNullableTimestampWithNotice(
	value: unknown,
	fieldName: string,
	jobofferId: string,
	notices: NoticeItem[],
): string | null {
	if (value === null || value === undefined || String(value).trim() === "") return null;
	const normalized = normalizeTimestamp(value);
	if (!normalized) {
		notices.push(
			platformWarning(
				"UNEXPECTED_INVALID_JOBOFFER_TIMESTAMP",
				`Joboffer ${jobofferId} enthält ein ungültiges ${fieldName}; das Feld wurde auf null gesetzt.`,
			),
		);
	}
	return normalized;
}

function normalizeCount(value: unknown, fieldName: string, jobofferId: string, notices: NoticeItem[]): number {
	if (value === null || value === undefined || value === "") {
		notices.push(
			platformWarning(
				"UNEXPECTED_NULL_JOBOFFER_COUNT",
				`Joboffer ${jobofferId} enthält keinen Wert für ${fieldName}; der Count wurde auf 0 gesetzt.`,
			),
		);
		return 0;
	}
	const numberValue = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(numberValue) || numberValue < 0) {
		notices.push(
			platformWarning(
				"UNEXPECTED_INVALID_JOBOFFER_COUNT",
				`Joboffer ${jobofferId} enthält einen ungültigen Wert für ${fieldName}; der Count wurde auf 0 gesetzt.`,
			),
		);
		return 0;
	}
	return Math.trunc(numberValue);
}

function normalizeBoolean(value: unknown, fieldName: string, jobofferId: string, notices: NoticeItem[]): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "t", "1", "yes"].includes(normalized)) return true;
		if (["false", "f", "0", "no"].includes(normalized)) return false;
	}
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
	}
	notices.push(
		platformWarning(
			"UNEXPECTED_INVALID_JOBOFFER_BOOLEAN",
			`Joboffer ${jobofferId} enthält keinen gültigen Boolean für ${fieldName}; der Wert wurde auf false gesetzt.`,
		),
	);
	return false;
}

function normalizeOptionalCount(value: unknown): number {
	if (value === null || value === undefined || value === "") return 0;
	const numberValue = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	return Number.isFinite(numberValue) && numberValue > 0 ? Math.trunc(numberValue) : 0;
}

function normalizeOptionalBoolean(value: unknown): boolean {
	if (value === null || value === undefined || value === "") return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return ["true", "t", "1", "yes"].includes(value.trim().toLowerCase());
	return value === 1;
}

function parseJsonArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function normalizePreviousProductAssignments(
	value: unknown,
	jobofferId: string,
	notices: NoticeItem[],
): ProductAssignment[] {
	const values = parseJsonArray(value);
	const assignments: ProductAssignment[] = [];
	for (const item of values) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			notices.push(
				platformWarning(
					"UNEXPECTED_INVALID_PRODUCT_ASSIGNMENT",
					`Joboffer ${jobofferId} enthält einen ungültigen Product Assignment Eintrag; der Eintrag wurde ausgelassen.`,
				),
			);
			continue;
		}
		const row = item as Record<string, unknown>;
		let product = getStringValue(row, "product");
		if (!product) {
			product = "UNKNOWN_PRODUCT";
			notices.push(
				platformWarning(
					"UNEXPECTED_NULL_PRODUCT_ASSIGNMENT_PRODUCT",
					`Joboffer ${jobofferId} enthält einen Product Assignment Eintrag ohne Product; UNKNOWN_PRODUCT wurde gesetzt.`,
				),
			);
		}
		const from = normalizeRequiredTimestamp(
			getFieldValue(row, "from"),
			"previousProductAssignments[].from",
			jobofferId,
			notices,
		);
		const to = normalizeRequiredTimestamp(
			getFieldValue(row, "to"),
			"previousProductAssignments[].to",
			jobofferId,
			notices,
		);
		if (!from || !to) continue;
		assignments.push({ product, from, to });
	}
	return assignments;
}

function normalizeInputTimestamp(value: unknown, fieldName: string): string | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`company_briefing.${fieldName} must be a timestamp string`);
	const normalized = normalizeTimestamp(value);
	if (!normalized) throw new Error(`company_briefing.${fieldName} must be a valid timestamp/date`);
	return normalized;
}

export function validateCompanyBriefingArgs(value: unknown): CompanyBriefingToolInput {
	if (!value || typeof value !== "object") {
		throw new Error("company_briefing arguments must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const companyId = typeof candidate.companyId === "string" ? candidate.companyId.trim() : "";
	if (!new RegExp(COMPANY_ID_PATTERN).test(companyId)) {
		throw new Error("company_briefing.companyId must be a JobMatch Company UUID");
	}
	const periodFrom = normalizeInputTimestamp(candidate.periodFrom, "periodFrom");
	const periodTo = normalizeInputTimestamp(candidate.periodTo, "periodTo");
	if (periodTo && !periodFrom) {
		throw new Error("company_briefing.periodFrom is required when periodTo is set");
	}
	return { companyId: companyId.toLowerCase(), periodFrom, periodTo };
}

export function mapJobofferActivityRows(rows: Record<string, unknown>[]): {
	joboffers: JobofferActivityOverviewItem[];
	notices: NoticeItem[];
} {
	const notices: NoticeItem[] = [];
	const joboffers: JobofferActivityOverviewItem[] = [];

	for (const row of rows) {
		const jobofferId = getStringValue(row, "jobofferId", "joboffer_id");
		if (!jobofferId) {
			notices.push(
				platformWarning(
					"UNEXPECTED_NULL_JOBOFFER_ID",
					"Ein Joboffer Activity Overview Eintrag ohne jobofferId wurde ausgelassen.",
				),
			);
			continue;
		}

		let title = getStringValue(row, "title");
		if (!title) {
			title = jobofferId;
			notices.push(
				platformWarning(
					"JOBOFFER_TITLE_FALLBACK_APPLIED",
					`Joboffer ${jobofferId} hat keinen Titel; die jobofferId wurde als Titel gesetzt.`,
				),
			);
		}

		joboffers.push({
			jobofferId,
			title,
			currentProduct: getStringValue(row, "currentProduct", "current_product"),
			currentProductSince: normalizeNullableTimestampWithNotice(
				getFieldValue(row, "currentProductSince", "current_product_since"),
				"currentProductSince",
				jobofferId,
				notices,
			),
			previousProductAssignments: normalizePreviousProductAssignments(
				getFieldValue(row, "previousProductAssignments", "previous_product_assignments"),
				jobofferId,
				notices,
			),
			currentlyActive: normalizeBoolean(
				getFieldValue(row, "currentlyActive", "currently_active"),
				"currentlyActive",
				jobofferId,
				notices,
			),
			wasPaidInPeriod: normalizeOptionalBoolean(getFieldValue(row, "wasPaidInPeriod", "was_paid_in_period")),
			wasFreemiumInPeriod: normalizeOptionalBoolean(
				getFieldValue(row, "wasFreemiumInPeriod", "was_freemium_in_period"),
			),
			newBewerbungenCount: normalizeCount(
				getFieldValue(row, "newBewerbungenCount", "new_bewerbungen_count"),
				"newBewerbungenCount",
				jobofferId,
				notices,
			),
			newPaidBewerbungenCount: normalizeOptionalCount(
				getFieldValue(row, "newPaidBewerbungenCount", "new_paid_bewerbungen_count"),
			),
			newFreemiumBewerbungenCount: normalizeOptionalCount(
				getFieldValue(row, "newFreemiumBewerbungenCount", "new_freemium_bewerbungen_count"),
			),
			newOtherBewerbungenCount: normalizeOptionalCount(
				getFieldValue(row, "newOtherBewerbungenCount", "new_other_bewerbungen_count"),
			),
			newHiresCount: normalizeCount(
				getFieldValue(row, "newHiresCount", "new_hires_count"),
				"newHiresCount",
				jobofferId,
				notices,
			),
			newPaidHiresCount: normalizeOptionalCount(getFieldValue(row, "newPaidHiresCount", "new_paid_hires_count")),
			newFreemiumHiresCount: normalizeOptionalCount(
				getFieldValue(row, "newFreemiumHiresCount", "new_freemium_hires_count"),
			),
			newOtherHiresCount: normalizeOptionalCount(getFieldValue(row, "newOtherHiresCount", "new_other_hires_count")),
			isExpiring: normalizeBoolean(
				getFieldValue(row, "isExpiring", "is_expiring"),
				"isExpiring",
				jobofferId,
				notices,
			),
			bookingEndsAt: normalizeNullableTimestampWithNotice(
				getFieldValue(row, "bookingEndsAt", "booking_ends_at"),
				"bookingEndsAt",
				jobofferId,
				notices,
			),
		});
	}

	return { joboffers, notices };
}

export function createJobofferActivityOverviewSignal(
	joboffers: JobofferActivityOverviewItem[],
): PlatformSignal<JobofferActivityOverviewData> {
	const paidActive = joboffers.filter((joboffer) => joboffer.wasPaidInPeriod).length;
	const freemiumActive = joboffers.filter((joboffer) => joboffer.wasFreemiumInPeriod).length;
	const otherActive = Math.max(0, joboffers.length - paidActive - freemiumActive);
	const paidBewerbungen = joboffers.reduce((sum, joboffer) => sum + joboffer.newPaidBewerbungenCount, 0);
	const freemiumBewerbungen = joboffers.reduce((sum, joboffer) => sum + joboffer.newFreemiumBewerbungenCount, 0);
	const paidHires = joboffers.reduce((sum, joboffer) => sum + joboffer.newPaidHiresCount, 0);
	const freemiumHires = joboffers.reduce((sum, joboffer) => sum + joboffer.newFreemiumHiresCount, 0);
	const otherBewerbungen = joboffers.reduce((sum, joboffer) => sum + joboffer.newOtherBewerbungenCount, 0);
	const otherHires = joboffers.reduce((sum, joboffer) => sum + joboffer.newOtherHiresCount, 0);
	const expiring = joboffers.filter((joboffer) => joboffer.isExpiring).length;
	const otherSuffix = otherActive > 0 ? `, Other: ${otherActive}` : "";
	const otherActivitySuffix =
		otherBewerbungen > 0 || otherHires > 0 ? `; Other ${otherBewerbungen}/${otherHires}` : "";
	const facts = [
		`${joboffers.length} Joboffers waren in der Briefing Period active (Paid: ${paidActive}, Freemium: ${freemiumActive}${otherSuffix}).`,
		`New Bewerbungen/Hires: Paid ${paidBewerbungen}/${paidHires}; Freemium ${freemiumBewerbungen}/${freemiumHires}${otherActivitySuffix}.`,
	];
	if (expiring > 0) {
		facts.push(`${expiring} Expiring Joboffers enden innerhalb der nächsten 7 Tage.`);
	}
	if (joboffers.length === 0) {
		facts.push("Keine Joboffers waren in der Briefing Period active.");
	}

	return {
		id: "platform.jobofferActivityOverview",
		type: JOBOFFER_ACTIVITY_OVERVIEW_TYPE,
		title: "Joboffer Bewerbungs-/Hire-Übersicht",
		facts,
		data: { joboffers },
	};
}

function buildNotice(
	severity: NoticeSeverity,
	code: string,
	message: string,
	affectedBlock: AffectedBlock,
): NoticeItem {
	return { severity, code, message, affectedBlock };
}

function platformWarning(code: string, message: string): NoticeItem {
	return buildNotice("WARNING", code, message, "PLATFORM_SIGNALS");
}

function crmWarning(code: string, message: string): NoticeItem {
	return buildNotice("WARNING", code, message, "CRM_SIGNALS");
}

function truncateText(value: string | null, maxLength: number): string | null {
	if (!value) return null;
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function formatCrmTypeLabel(objectType: string): string {
	switch (objectType) {
		case "call":
			return "Call";
		case "email":
			return "Email";
		case "deal":
			return "Deal";
		case "note":
			return "Note";
		case "meeting":
			return "Meeting";
		case "task":
			return "Task";
		default:
			return objectType;
	}
}

function createCrmActivityTitle(row: Record<string, unknown>, objectType: string, objectId: string): string {
	const title =
		objectType === "call"
			? getStringValue(row, "callTitle", "call_title", "callSummary", "call_summary")
			: objectType === "email"
				? getStringValue(row, "emailSubject", "email_subject")
				: objectType === "deal"
					? getStringValue(row, "dealName", "deal_name")
					: objectType === "task"
						? getStringValue(row, "taskSubject", "task_subject")
						: objectType === "meeting"
							? getStringValue(row, "meetingTitle", "meeting_title")
							: truncateText(getStringValue(row, "noteBody", "note_body"), 80);
	return title || `${formatCrmTypeLabel(objectType)} ${objectId}`;
}

function compactParts(...parts: Array<string | null>): string | null {
	const compacted = parts.filter((part): part is string => Boolean(part));
	return compacted.length > 0 ? compacted.join(", ") : null;
}

function createCrmActivityDetail(row: Record<string, unknown>, objectType: string): string | null {
	const transcriptExcerpt = truncateText(getStringValue(row, "transcriptText", "transcript_text"), 180);
	switch (objectType) {
		case "call":
			return compactParts(
				getStringValue(row, "callDirection", "call_direction"),
				getStringValue(row, "callStatus", "call_status"),
				getStringValue(row, "callDisposition", "call_disposition"),
				truncateText(getStringValue(row, "callSummary", "call_summary"), 180) || transcriptExcerpt,
			);
		case "email":
			return compactParts(
				getStringValue(row, "emailDirection", "email_direction"),
				getStringValue(row, "emailStatus", "email_status"),
				getStringValue(row, "emailFromEmail", "email_from_email"),
				getStringValue(row, "emailToEmail", "email_to_email"),
			);
		case "deal":
			return compactParts(
				getStringValue(row, "dealStage", "deal_stage"),
				getStringValue(row, "dealPipeline", "deal_pipeline"),
				getStringValue(row, "dealAmountRaw", "deal_amount_raw"),
			);
		case "task":
			return compactParts(
				getStringValue(row, "taskStatus", "task_status"),
				getStringValue(row, "taskPriority", "task_priority"),
				getStringValue(row, "taskType", "task_type"),
			);
		case "meeting":
			return compactParts(getStringValue(row, "meetingOutcome", "meeting_outcome"));
		case "note":
			return truncateText(getStringValue(row, "noteBody", "note_body"), 180);
		default:
			return null;
	}
}

export function mapCrmActivityRows(rows: Record<string, unknown>[]): {
	activities: CrmActivityItem[];
	notices: NoticeItem[];
} {
	const notices: NoticeItem[] = [];
	const activities: CrmActivityItem[] = [];

	for (const row of rows) {
		const objectType = getStringValue(row, "objectType", "object_type_label")?.toLowerCase();
		const objectId = getStringValue(row, "objectId", "object_id");
		const occurredAt = normalizeTimestamp(getFieldValue(row, "occurredAt", "occurred_at"));
		if (!objectType || !objectId || !occurredAt) {
			notices.push(
				crmWarning(
					"UNEXPECTED_INVALID_CRM_ACTIVITY_ROW",
					"Ein CRM Activity Eintrag ohne objectType, objectId oder occurredAt wurde ausgelassen.",
				),
			);
			continue;
		}

		activities.push({
			objectType,
			objectId,
			occurredAt,
			title: createCrmActivityTitle(row, objectType, objectId),
			detail: createCrmActivityDetail(row, objectType),
			transcriptExcerpt: truncateText(getStringValue(row, "transcriptText", "transcript_text"), 240),
		});
	}

	return { activities, notices };
}

export function createCrmActivityOverviewSignal(activities: CrmActivityItem[]): CrmSignal<CrmActivityOverviewData> {
	const countsByType = activities.reduce<Record<string, number>>((counts, activity) => {
		counts[activity.objectType] = (counts[activity.objectType] || 0) + 1;
		return counts;
	}, {});
	const countSummary = Object.entries(countsByType)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([type, count]) => `${formatCrmTypeLabel(type)}: ${count}`)
		.join(", ");
	const facts = [
		activities.length === 0
			? "Keine CRM Aktivitäten in der Briefing Period gefunden."
			: `${activities.length} CRM Aktivitäten in der Briefing Period gefunden (${countSummary}).`,
	];

	return {
		id: "crm.activityOverview",
		type: CRM_ACTIVITY_OVERVIEW_TYPE,
		title: "CRM Aktivitätsübersicht",
		facts,
		data: { activities, countsByType },
	};
}

function mapCompanyContextRows(rows: Record<string, unknown>[], requestedCompanyId: string): CompanyContextLookup {
	if (rows.length === 0) return { status: "not_found" };
	if (rows.length > 1) return { status: "not_unique" };
	const row = rows[0];
	const notices: NoticeItem[] = [];
	const companyId = getStringValue(row, "companyId", "company_id") || requestedCompanyId;
	const hubspotCompanyId = getStringValue(row, "hubspotCompanyId", "hubspot_company_id");
	let companyName = getStringValue(row, "companyName", "company_name");
	if (!companyName) {
		companyName = companyId;
		notices.push(
			buildNotice(
				"WARNING",
				"COMPANY_NAME_FALLBACK_APPLIED",
				"Die Company hatte keinen HubSpot Company Name; die companyId wurde als Name gesetzt.",
				"CRM_SIGNALS",
			),
		);
	}

	return {
		status: "found",
		company: {
			companyId,
			companyName,
			hubspotCompanyId,
			lastReachedCallAt: normalizeTimestamp(getFieldValue(row, "lastReachedCallAt", "last_reached_call_at")),
			notices,
		},
	};
}

export function buildCompanyContextSql(companyId: string): string {
	return `
select
    company_id as "companyId",
    hubspot_company_id as "hubspotCompanyId",
    company_name as "companyName",
    briefing_window_started_at as "lastReachedCallAt"
from {{ ref('90_hubspot__fct_pre_call_agent_brief') }}
where company_id = ${sqlLiteral(companyId)}`;
}

export function buildBookingInventoryFreshnessSql(): string {
	return `
select
    max(active_date)::text as "maxActiveDate"
from {{ ref('90_bookings__fct_active_booking_inventory_daily') }}`;
}

export function buildJobofferActivityOverviewSql(companyId: string, briefingPeriod: BriefingPeriod): string {
	return `
with params as (
    select
        ${sqlLiteral(companyId)}::text as company_id,
        ${sqlLiteral(briefingPeriod.from)}::timestamptz as period_from,
        ${sqlLiteral(briefingPeriod.to)}::timestamptz as period_to
),

inventory_in_period as (
    select
        inv.joboffer_id,
        inv.bc_id,
        inv.active_date,
        inv.active_from,
        inv.active_until,
        inv.booking_cancel_at,
        inv.product,
        inv.job_name_internal,
        inv.job_name_external
    from {{ ref('90_bookings__fct_active_booking_inventory_daily') }} inv
    inner join params p
        on inv.bc_id = p.company_id
    where inv.active_date >= p.period_from::date
      and inv.active_date <= (p.period_to - interval '1 microsecond')::date
),

base_joboffers as (
    select distinct
        joboffer_id
    from inventory_in_period
),

latest_period_inventory as (
    select
        x.*
    from (
        select
            iip.*,
            row_number() over (
                partition by iip.joboffer_id
                order by
                    iip.active_date desc,
                    iip.active_from desc nulls last,
                    iip.booking_cancel_at desc nulls last
            ) as rn
        from inventory_in_period iip
    ) x
    where x.rn = 1
),

current_inventory as (
    select
        inv.joboffer_id,
        inv.bc_id,
        inv.booking_cancel_at,
        inv.product,
        inv.active_from,
        inv.active_until,
        inv.job_name_internal,
        inv.job_name_external
    from {{ ref('90_bookings__fct_active_booking_inventory_daily') }} inv
    inner join params p
        on inv.bc_id = p.company_id
    where inv.active_date = p.period_to::date
      and inv.active_from <= p.period_to
      and coalesce(inv.active_until, timestamp '9999-12-31') > p.period_to
),

product_assignment_segments as (
    select distinct
        iip.joboffer_id,
        iip.product,
        greatest(iip.active_from, p.period_from) as assignment_from,
        least(coalesce(iip.active_until, p.period_to), p.period_to) as assignment_to
    from inventory_in_period iip
    cross join params p
),

product_assignment_ordered as (
    select
        product_assignment_segments.*,
        lag(product) over (
            partition by joboffer_id
            order by assignment_from, assignment_to, product
        ) as previous_product,
        lag(assignment_to) over (
            partition by joboffer_id
            order by assignment_from, assignment_to, product
        ) as previous_assignment_to
    from product_assignment_segments
),

product_assignment_groups as (
    select
        product_assignment_ordered.*,
        sum(
            case
                when previous_product = product
                 and previous_assignment_to >= assignment_from
                    then 0
                else 1
            end
        ) over (
            partition by joboffer_id
            order by assignment_from, assignment_to, product
            rows unbounded preceding
        ) as assignment_group
    from product_assignment_ordered
),

product_assignment_merged as (
    select
        joboffer_id,
        product,
        min(assignment_from) as assignment_from,
        max(assignment_to) as assignment_to
    from product_assignment_groups
    group by joboffer_id, product, assignment_group
),

previous_product_assignments as (
    select
        pam.joboffer_id,
        jsonb_agg(
            jsonb_build_object(
                'product', pam.product,
                'from', pam.assignment_from,
                'to', pam.assignment_to
            )
            order by pam.assignment_from, pam.assignment_to, pam.product
        ) as previous_product_assignments_json
    from product_assignment_merged pam
    cross join params p
    left join current_inventory ci
        on ci.joboffer_id = pam.joboffer_id
       and ci.product = pam.product
       and pam.assignment_to = p.period_to
    where ci.joboffer_id is null
      and pam.assignment_to <= p.period_to
    group by 1
),

inventory_product_buckets as (
    select
        iip.joboffer_id,
        bool_or(iip.product in ('Starter', 'Pro', 'Premium', 'BOOKING_STARTER', 'BOOKING_STANDARD', 'BOOKING_PREMIUM', 'jm_matching_starter', 'jm_matching_01', 'jm_matching_02')) as was_paid_in_period,
        bool_or(iip.product in ('Freemium', 'ACTIVE', 'jm_matching_free', 'BOOKING_FREE')) as was_freemium_in_period
    from inventory_in_period iip
    group by 1
),

applications_in_period as (
    select
        app.joboffer_id,
        count(*) as new_bewerbungen_count,
        count(*) filter (where app.booking_model in ('Starter', 'Pro', 'Premium', 'BOOKING_STARTER', 'BOOKING_STANDARD', 'BOOKING_PREMIUM', 'jm_matching_starter', 'jm_matching_01', 'jm_matching_02')) as new_paid_bewerbungen_count,
        count(*) filter (where app.booking_model in ('Freemium', 'ACTIVE', 'jm_matching_free', 'BOOKING_FREE')) as new_freemium_bewerbungen_count,
        count(*) filter (where coalesce(app.booking_model, '') not in ('Starter', 'Pro', 'Premium', 'BOOKING_STARTER', 'BOOKING_STANDARD', 'BOOKING_PREMIUM', 'jm_matching_starter', 'jm_matching_01', 'jm_matching_02', 'Freemium', 'ACTIVE', 'jm_matching_free', 'BOOKING_FREE')) as new_other_bewerbungen_count
    from {{ ref('90_matching__fct_applications') }} app
    inner join params p
        on app.bc_id = p.company_id
    inner join base_joboffers b
        on b.joboffer_id = app.joboffer_id
    where app.applied_at >= p.period_from
      and app.applied_at < p.period_to
    group by 1
),

hires_in_period as (
    select
        app.joboffer_id,
        count(*) as new_hires_count,
        count(*) filter (where app.booking_model in ('Starter', 'Pro', 'Premium', 'BOOKING_STARTER', 'BOOKING_STANDARD', 'BOOKING_PREMIUM', 'jm_matching_starter', 'jm_matching_01', 'jm_matching_02')) as new_paid_hires_count,
        count(*) filter (where app.booking_model in ('Freemium', 'ACTIVE', 'jm_matching_free', 'BOOKING_FREE')) as new_freemium_hires_count,
        count(*) filter (where coalesce(app.booking_model, '') not in ('Starter', 'Pro', 'Premium', 'BOOKING_STARTER', 'BOOKING_STANDARD', 'BOOKING_PREMIUM', 'jm_matching_starter', 'jm_matching_01', 'jm_matching_02', 'Freemium', 'ACTIVE', 'jm_matching_free', 'BOOKING_FREE')) as new_other_hires_count
    from {{ ref('90_matching__fct_applications') }} app
    inner join params p
        on app.bc_id = p.company_id
    inner join base_joboffers b
        on b.joboffer_id = app.joboffer_id
    where app.current_match_status = 'HIRED'
      and app.current_match_status_created_at >= p.period_from
      and app.current_match_status_created_at < p.period_to
    group by 1
),

final as (
    select
        b.joboffer_id as "jobofferId",
        coalesce(
            ci.job_name_internal,
            lpi.job_name_internal,
            ci.job_name_external,
            lpi.job_name_external,
            b.joboffer_id
        ) as title,
        ci.product as "currentProduct",
        ci.active_from as "currentProductSince",
        coalesce(ppa.previous_product_assignments_json, '[]'::jsonb) as "previousProductAssignments",
        (ci.joboffer_id is not null) as "currentlyActive",
        coalesce(ipb.was_paid_in_period, false) as "wasPaidInPeriod",
        coalesce(ipb.was_freemium_in_period, false) as "wasFreemiumInPeriod",
        coalesce(aip.new_bewerbungen_count, 0) as "newBewerbungenCount",
        coalesce(aip.new_paid_bewerbungen_count, 0) as "newPaidBewerbungenCount",
        coalesce(aip.new_freemium_bewerbungen_count, 0) as "newFreemiumBewerbungenCount",
        coalesce(aip.new_other_bewerbungen_count, 0) as "newOtherBewerbungenCount",
        coalesce(hip.new_hires_count, 0) as "newHiresCount",
        coalesce(hip.new_paid_hires_count, 0) as "newPaidHiresCount",
        coalesce(hip.new_freemium_hires_count, 0) as "newFreemiumHiresCount",
        coalesce(hip.new_other_hires_count, 0) as "newOtherHiresCount",
        (
            ci.joboffer_id is not null
            and ci.booking_cancel_at is not null
            and ci.booking_cancel_at >= p.period_to
            and ci.booking_cancel_at < p.period_to + interval '7 days'
        ) as "isExpiring",
        coalesce(ci.booking_cancel_at, lpi.booking_cancel_at) as "bookingEndsAt"
    from base_joboffers b
    cross join params p
    left join latest_period_inventory lpi
        on lpi.joboffer_id = b.joboffer_id
    left join current_inventory ci
        on ci.joboffer_id = b.joboffer_id
    left join previous_product_assignments ppa
        on ppa.joboffer_id = b.joboffer_id
    left join inventory_product_buckets ipb
        on ipb.joboffer_id = b.joboffer_id
    left join applications_in_period aip
        on aip.joboffer_id = b.joboffer_id
    left join hires_in_period hip
        on hip.joboffer_id = b.joboffer_id
)

select *
from final
order by
    case
        when "isExpiring" then 1
        when "newHiresCount" > 0 then 2
        when "newBewerbungenCount" > 0 then 3
        when "currentlyActive" then 4
        else 5
    end,
    "newHiresCount" desc,
    "newBewerbungenCount" desc,
    "bookingEndsAt" asc nulls last,
    title asc,
    "jobofferId" asc`;
}

export function buildCrmActivitySql(companyId: string, briefingPeriod: BriefingPeriod): string {
	return `
with params as (
    select
        ${sqlLiteral(companyId)}::text as company_id,
        ${sqlLiteral(briefingPeriod.from)}::timestamptz as period_from,
        ${sqlLiteral(briefingPeriod.to)}::timestamptz as period_to
)

select
    crm.object_type_label as "objectType",
    crm.object_id as "objectId",
    crm.occurred_at as "occurredAt",
    crm.deal_name as "dealName",
    crm.deal_pipeline as "dealPipeline",
    crm.deal_stage as "dealStage",
    crm.deal_amount_raw as "dealAmountRaw",
    crm.task_subject as "taskSubject",
    crm.task_status as "taskStatus",
    crm.task_priority as "taskPriority",
    crm.task_type as "taskType",
    left(crm.note_body, 1000) as "noteBody",
    crm.call_title as "callTitle",
    crm.call_direction as "callDirection",
    crm.call_status as "callStatus",
    crm.call_disposition as "callDisposition",
    left(crm.call_summary, 1000) as "callSummary",
    crm.has_transcript as "hasTranscript",
    left(crm.transcript_text, 1000) as "transcriptText",
    crm.email_subject as "emailSubject",
    crm.email_direction as "emailDirection",
    crm.email_status as "emailStatus",
    crm.email_from_email as "emailFromEmail",
    crm.email_to_email as "emailToEmail",
    crm.meeting_title as "meetingTitle",
    crm.meeting_outcome as "meetingOutcome"
from {{ ref('90_hubspot__fct_company_briefing_crm_activity') }} crm
inner join params p
    on crm.company_id = p.company_id
where crm.occurred_at >= p.period_from
  and crm.occurred_at < p.period_to
order by
    crm.occurred_at desc,
    crm.object_type_label asc,
    crm.object_id asc`;
}

class DbtCompanyBriefingDataAccess implements CompanyBriefingDataAccess {
	constructor(
		private readonly executor: Executor,
		private readonly workspaceRoot: string,
		private readonly workingDir: string,
		private readonly sessionDir: string,
	) {}

	private async query(label: string, inlineSql: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
		const dbtTool = createDbtTool(this.executor, this.workspaceRoot, this.workingDir, this.sessionDir);
		const result = await dbtTool.execute(
			`company-briefing-${randomUUID()}`,
			{
				label,
				action: "show",
				inlineSql,
				target: getCompanyBriefingDbtTarget(),
				output: "json",
				limit: DEFAULT_QUERY_LIMIT,
				timeout: getCompanyBriefingQueryTimeoutSeconds(),
			},
			signal,
		);
		const jsonOutputPath = (result.details as { jsonOutputPath?: unknown } | undefined)?.jsonOutputPath;
		if (typeof jsonOutputPath !== "string" || jsonOutputPath.length === 0) {
			throw new Error("dbt show did not produce a JSON output path");
		}
		const rows = (JSON.parse(await readFile(jsonOutputPath, "utf-8")) as { show?: unknown[] } | null)?.show;
		if (!Array.isArray(rows)) throw new Error("dbt JSON output did not contain a show array");
		if (!rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
			throw new Error("dbt JSON output rows must be objects");
		}
		return rows as Record<string, unknown>[];
	}

	async getCompanyContext(companyId: string, signal?: AbortSignal): Promise<CompanyContextLookup> {
		const rows = await this.query(
			"Load Company Briefing authorization context",
			buildCompanyContextSql(companyId),
			signal,
		);
		return mapCompanyContextRows(rows, companyId);
	}

	async getBookingInventoryFreshness(signal?: AbortSignal): Promise<BookingInventoryFreshness> {
		const rows = await this.query(
			"Check Booking Inventory freshness for Company Briefing",
			buildBookingInventoryFreshnessSql(),
			signal,
		);
		const row = rows[0] || {};
		return { maxActiveDate: getStringValue(row, "maxActiveDate", "max_active_date") };
	}

	async getJobofferActivityRows(
		companyId: string,
		briefingPeriod: BriefingPeriod,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>[]> {
		return this.query(
			"Load JOBOFFER_ACTIVITY_OVERVIEW for Company Briefing",
			buildJobofferActivityOverviewSql(companyId, briefingPeriod),
			signal,
		);
	}

	async getCrmActivityRows(
		companyId: string,
		briefingPeriod: BriefingPeriod,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>[]> {
		return this.query(
			"Load CRM_ACTIVITY_OVERVIEW for Company Briefing",
			buildCrmActivitySql(companyId, briefingPeriod),
			signal,
		);
	}
}

function utcDate(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function dateOnlyFromUnknown(value: string | null): string | null {
	if (!value) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const normalized = normalizeTimestamp(value);
	return normalized ? normalized.slice(0, 10) : null;
}

export function getBookingInventoryStalenessNotice(
	freshness: BookingInventoryFreshness,
	periodTo: string,
): NoticeItem | undefined {
	const periodToDate = utcDate(new Date(periodTo));
	const maxActiveDate = dateOnlyFromUnknown(freshness.maxActiveDate);
	if (!maxActiveDate) {
		return platformWarning(
			"BOOKING_INVENTORY_FRESHNESS_UNKNOWN",
			"Die Datenfrische des Booking Inventory konnte nicht bestimmt werden.",
		);
	}
	if (maxActiveDate < periodToDate) {
		return platformWarning(
			"BOOKING_INVENTORY_STALE",
			`Booking Inventory wirkt veraltet (max active_date: ${maxActiveDate}, Briefing-Datum: ${periodToDate}).`,
		);
	}
	return undefined;
}

export async function collectPlatformSignals(args: {
	companyId: string;
	briefingPeriod: BriefingPeriod;
	dataAccess: CompanyBriefingDataAccess;
	signal?: AbortSignal;
}): Promise<{ platformSignals: PlatformSignal[]; notices: NoticeItem[] }> {
	const notices: NoticeItem[] = [];
	try {
		const freshness = await args.dataAccess.getBookingInventoryFreshness(args.signal);
		const stalenessNotice = getBookingInventoryStalenessNotice(freshness, args.briefingPeriod.to);
		if (stalenessNotice) notices.push(stalenessNotice);
	} catch {
		notices.push(
			platformWarning(
				"BOOKING_INVENTORY_FRESHNESS_UNAVAILABLE",
				"Die Datenfrische des Booking Inventory konnte nicht geprüft werden.",
			),
		);
	}

	let rows: Record<string, unknown>[];
	try {
		rows = await args.dataAccess.getJobofferActivityRows(args.companyId, args.briefingPeriod, args.signal);
	} catch {
		notices.push(
			platformWarning(
				"PLATFORM_SIGNALS_QUERY_FAILED",
				"Platform Signals konnten nicht vollständig geladen werden; das Company Briefing wird ohne Joboffer Activity Overview fortgesetzt.",
			),
		);
		return { platformSignals: [], notices };
	}

	const mapped = mapJobofferActivityRows(rows);
	notices.push(...mapped.notices);
	return {
		platformSignals: [createJobofferActivityOverviewSignal(mapped.joboffers)],
		notices,
	};
}

export async function collectCrmSignals(args: {
	companyId: string;
	briefingPeriod: BriefingPeriod;
	dataAccess: CompanyBriefingDataAccess;
	signal?: AbortSignal;
}): Promise<{ crmSignals: CrmSignal[]; notices: NoticeItem[] }> {
	let rows: Record<string, unknown>[];
	try {
		rows = await args.dataAccess.getCrmActivityRows(args.companyId, args.briefingPeriod, args.signal);
	} catch {
		return {
			crmSignals: [],
			notices: [
				crmWarning(
					"CRM_SIGNALS_QUERY_FAILED",
					"CRM Signals konnten nicht aus dem Company Briefing CRM Activity Modell geladen werden.",
				),
			],
		};
	}

	const mapped = mapCrmActivityRows(rows);
	return {
		crmSignals: [createCrmActivityOverviewSignal(mapped.activities)],
		notices: mapped.notices,
	};
}

function determineExplicitBriefingPeriod(
	input: CompanyBriefingToolInput,
	company: CompanyContext,
	now: Date,
): BriefingPeriod | undefined {
	if (!input.periodFrom) return undefined;
	return {
		from: input.periodFrom,
		to: input.periodTo || now.toISOString(),
		basis: "EXPLICIT",
		lastReachedCallAt: normalizeTimestamp(company.lastReachedCallAt),
	};
}

function determineBriefingPeriod(
	company: CompanyContext,
	periodTo: Date,
): { period: BriefingPeriod; notices: NoticeItem[] } {
	const notices: NoticeItem[] = [];
	if (company.lastReachedCallAt) {
		const lastReached = new Date(company.lastReachedCallAt);
		if (!Number.isNaN(lastReached.getTime()) && lastReached.getTime() < periodTo.getTime()) {
			const ageMs = periodTo.getTime() - lastReached.getTime();
			const maxAgeMs = MAX_LAST_REACHED_CALL_AGE_DAYS * 24 * 60 * 60 * 1000;
			if (ageMs <= maxAgeMs) {
				return {
					period: {
						from: lastReached.toISOString(),
						to: periodTo.toISOString(),
						basis: "LAST_REACHED_CALL",
						lastReachedCallAt: lastReached.toISOString(),
					},
					notices,
				};
			}
			notices.push(
				buildNotice(
					"WARNING",
					"LAST_REACHED_CALL_TOO_OLD",
					"Der Last Reached Call ist älter als 180 Tage; die 60-Tage-Fallback-Period wurde verwendet.",
					"CRM_SIGNALS",
				),
			);
		} else {
			notices.push(
				buildNotice(
					"WARNING",
					"LAST_REACHED_CALL_INVALID",
					"Der Last Reached Call liegt nicht vor der Request-Zeit; die 60-Tage-Fallback-Period wurde verwendet.",
					"CRM_SIGNALS",
				),
			);
		}
	} else {
		notices.push(
			buildNotice(
				"INFO",
				"BRIEFING_PERIOD_FALLBACK_60_DAYS",
				"Kein Last Reached Call gefunden; die Briefing Period nutzt den 60-Tage-Fallback.",
				"CRM_SIGNALS",
			),
		);
	}

	const periodFrom = new Date(periodTo.getTime() - FALLBACK_PERIOD_DAYS * 24 * 60 * 60 * 1000);
	return {
		period: {
			from: periodFrom.toISOString(),
			to: periodTo.toISOString(),
			basis: "FALLBACK_60_DAYS",
			lastReachedCallAt: null,
		},
		notices,
	};
}

function createFailedResponse(requestId: string, companyId: string, notice: NoticeItem): CompanyBriefingResponse {
	return {
		status: "FAILED",
		requestId,
		companyId,
		briefing: null,
		markdown: null,
		notices: [notice],
	};
}

function hasWarnings(notices: NoticeItem[]): boolean {
	return notices.some((notice) => notice.severity === "WARNING");
}

export async function executeCompanyBriefing(
	input: CompanyBriefingToolInput,
	services: CompanyBriefingServices,
	signal?: AbortSignal,
): Promise<CompanyBriefingResponse> {
	const requestId = services.requestIdFactory();
	const fail = (code: string, message: string) =>
		createFailedResponse(requestId, input.companyId, buildNotice("BLOCKING", code, message, "CRM_SIGNALS"));
	let companyLookup: CompanyContextLookup;
	try {
		companyLookup = await services.dataAccess.getCompanyContext(input.companyId, signal);
	} catch {
		return fail(
			"COMPANY_CONTEXT_UNAVAILABLE",
			"Der Company Kontext konnte nicht geladen werden; es wurde kein Company Briefing ausgegeben.",
		);
	}

	if (companyLookup.status === "not_found") {
		return fail(
			"HUBSPOT_COMPANY_NOT_FOUND",
			"Für diese companyId wurde keine HubSpot Company gefunden; es wurde kein Company Briefing ausgegeben.",
		);
	}
	if (companyLookup.status === "not_unique") {
		return fail(
			"HUBSPOT_COMPANY_NOT_UNIQUE",
			"Für diese companyId wurden mehrere HubSpot Companies gefunden; es wurde kein Company Briefing ausgegeben.",
		);
	}

	const company = companyLookup.company;

	const periodTo = services.now();
	const explicitPeriod = determineExplicitBriefingPeriod(input, company, periodTo);
	if (explicitPeriod && new Date(explicitPeriod.from).getTime() >= new Date(explicitPeriod.to).getTime()) {
		return fail(
			"INVALID_BRIEFING_PERIOD",
			"Die explizite Briefing Period ist ungültig; periodFrom muss vor periodTo liegen.",
		);
	}
	const { period, notices: periodNotices } = explicitPeriod
		? { period: explicitPeriod, notices: [] }
		: determineBriefingPeriod(company, periodTo);
	const briefingNotices: NoticeItem[] = [...company.notices, ...periodNotices];
	const platformResult = await collectPlatformSignals({
		companyId: input.companyId,
		briefingPeriod: period,
		dataAccess: services.dataAccess,
		signal,
	});
	briefingNotices.push(...platformResult.notices);
	const crmResult = await collectCrmSignals({
		companyId: input.companyId,
		briefingPeriod: period,
		dataAccess: services.dataAccess,
		signal,
	});
	briefingNotices.push(...crmResult.notices);

	const briefing: CompanyBriefing = {
		companyId: input.companyId,
		companyName: company.companyName,
		briefingPeriod: period,
		signalInterpretation: { summary: [], themes: [] },
		salesOpportunities: [],
		platformSignals: platformResult.platformSignals,
		crmSignals: crmResult.crmSignals,
		notices: briefingNotices,
	};
	const markdown = renderCompanyBriefingMarkdown(briefing);

	return {
		status: hasWarnings(briefingNotices) ? "OK_WITH_WARNINGS" : "OK",
		requestId,
		companyId: input.companyId,
		briefing,
		markdown,
		notices: briefingNotices,
	};
}

function createDefaultServices(args: CreateCompanyBriefingToolArgs): CompanyBriefingServices {
	return {
		dataAccess:
			args.dataAccess ||
			new DbtCompanyBriefingDataAccess(args.executor, args.workspaceRoot, args.workingDir, args.sessionDir),
		now: args.now || (() => new Date()),
		requestIdFactory: args.requestIdFactory || (() => randomUUID()),
	};
}

function sanitizeMarkdownText(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

function formatDateTimeForMarkdown(value: string | null): string {
	if (!value) return "unbekannt";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function formatNullableProduct(joboffer: JobofferActivityOverviewItem): string {
	if (!joboffer.currentProduct) return "kein aktuelles Product";
	const since = joboffer.currentProductSince ? ` seit ${formatDateTimeForMarkdown(joboffer.currentProductSince)}` : "";
	return `${joboffer.currentProduct}${since}`;
}

function findJobofferActivitySignal(
	briefing: CompanyBriefing,
): PlatformSignal<JobofferActivityOverviewData> | undefined {
	return briefing.platformSignals.find((signal) => signal.type === JOBOFFER_ACTIVITY_OVERVIEW_TYPE) as
		| PlatformSignal<JobofferActivityOverviewData>
		| undefined;
}

function findCrmActivitySignal(briefing: CompanyBriefing): CrmSignal<CrmActivityOverviewData> | undefined {
	return briefing.crmSignals.find((signal) => signal.type === CRM_ACTIVITY_OVERVIEW_TYPE) as
		| CrmSignal<CrmActivityOverviewData>
		| undefined;
}

function renderExecutiveSummary(briefing: CompanyBriefing): string {
	const jobofferSignal = findJobofferActivitySignal(briefing);
	return jobofferSignal
		? jobofferSignal.facts.map((fact) => `• ${fact}`).join("\n")
		: "• Company Briefing erstellt; die Joboffer Activity Overview ist nicht verfügbar.";
}

function renderJobofferActivityOverviewMarkdown(signal: PlatformSignal<JobofferActivityOverviewData>): string {
	const joboffers = signal.data.joboffers;
	if (joboffers.length === 0) {
		return "• Keine Joboffers waren in der Briefing Period active.";
	}
	const paidActive = joboffers.filter((joboffer) => joboffer.wasPaidInPeriod).length;
	const freemiumActive = joboffers.filter((joboffer) => joboffer.wasFreemiumInPeriod).length;
	const paidBewerbungen = joboffers.reduce((sum, joboffer) => sum + joboffer.newPaidBewerbungenCount, 0);
	const freemiumBewerbungen = joboffers.reduce((sum, joboffer) => sum + joboffer.newFreemiumBewerbungenCount, 0);
	const paidHires = joboffers.reduce((sum, joboffer) => sum + joboffer.newPaidHiresCount, 0);
	const freemiumHires = joboffers.reduce((sum, joboffer) => sum + joboffer.newFreemiumHiresCount, 0);
	const lines: string[] = [
		`• *Paid:* ${paidActive} active Joboffers, ${paidBewerbungen} New Bewerbungen, ${paidHires} New Hires`,
		`• *Freemium:* ${freemiumActive} active Joboffers, ${freemiumBewerbungen} New Bewerbungen, ${freemiumHires} New Hires`,
	];
	let paidNoActivity = 0;
	let freemiumNoActivity = 0;
	let otherNoActivity = 0;
	let inactiveNoActivity = 0;
	let hiddenWithSignals = 0;
	let shownWithSignals = 0;
	for (const joboffer of joboffers) {
		if (!joboffer.isExpiring && joboffer.newHiresCount === 0 && joboffer.newBewerbungenCount === 0) {
			if (!joboffer.currentlyActive) inactiveNoActivity += 1;
			else if (joboffer.wasPaidInPeriod) paidNoActivity += 1;
			else if (joboffer.wasFreemiumInPeriod) freemiumNoActivity += 1;
			else otherNoActivity += 1;
			continue;
		}
		if (shownWithSignals >= INLINE_JOBOFFER_DETAIL_LIMIT) {
			hiddenWithSignals += 1;
			continue;
		}
		shownWithSignals += 1;
		const parts = [
			`${joboffer.newBewerbungenCount} New Bewerbungen (${joboffer.newPaidBewerbungenCount} Paid / ${joboffer.newFreemiumBewerbungenCount} Freemium)`,
			`${joboffer.newHiresCount} New Hires (${joboffer.newPaidHiresCount} Paid / ${joboffer.newFreemiumHiresCount} Freemium)`,
			formatNullableProduct(joboffer),
			joboffer.isExpiring ? `Expiring am ${formatDateTimeForMarkdown(joboffer.bookingEndsAt)}` : undefined,
			joboffer.currentlyActive ? "aktuell active" : "aktuell nicht active",
		].filter((part): part is string => Boolean(part));
		lines.push(`• *${sanitizeMarkdownText(joboffer.title)}* (${joboffer.jobofferId}): ${parts.join(", ")}`);
	}
	if (hiddenWithSignals > 0) {
		lines.push(
			`• ${hiddenWithSignals} weitere Joboffers mit New Bewerbungen/New Hires/Expiring nicht inline angezeigt.`,
		);
	}
	if (paidNoActivity > 0) {
		lines.push(`• ${paidNoActivity} weitere active Paid Joboffers ohne New Bewerbungen/New Hires.`);
	}
	if (freemiumNoActivity > 0) {
		lines.push(`• ${freemiumNoActivity} weitere active Freemium Joboffers ohne New Bewerbungen/New Hires.`);
	}
	if (otherNoActivity > 0) {
		lines.push(
			`• ${otherNoActivity} weitere active Joboffers ohne Product-Bucket und ohne New Bewerbungen/New Hires.`,
		);
	}
	if (inactiveNoActivity > 0) {
		lines.push(
			`• ${inactiveNoActivity} weitere Joboffers waren in der Briefing Period active, sind aber aktuell nicht active und hatten keine New Bewerbungen/New Hires.`,
		);
	}
	return lines.join("\n");
}

function renderPlatformSignalsMarkdown(briefing: CompanyBriefing): string {
	if (briefing.platformSignals.length === 0) {
		return "• Platform Signals sind nicht verfügbar.";
	}
	return briefing.platformSignals
		.map((signal) => {
			if (signal.type === JOBOFFER_ACTIVITY_OVERVIEW_TYPE) {
				return `*${signal.title}*\n${renderJobofferActivityOverviewMarkdown(
					signal as PlatformSignal<JobofferActivityOverviewData>,
				)}`;
			}
			return `*${signal.title}*\n${signal.facts.map((fact) => `• ${fact}`).join("\n")}`;
		})
		.join("\n\n");
}

function renderCrmActivityOverviewMarkdown(signal: CrmSignal<CrmActivityOverviewData>): string {
	const lines = signal.facts.map((fact) => `• ${fact}`);
	const activities = signal.data?.activities || [];
	for (const activity of activities.slice(0, INLINE_CRM_ACTIVITY_LIMIT)) {
		const detail = activity.detail ? `: ${sanitizeMarkdownText(activity.detail)}` : "";
		lines.push(
			`• ${formatDateTimeForMarkdown(activity.occurredAt)} *${formatCrmTypeLabel(activity.objectType)}* – ${sanitizeMarkdownText(activity.title)}${detail}`,
		);
	}
	if (activities.length > INLINE_CRM_ACTIVITY_LIMIT) {
		lines.push(`• ${activities.length - INLINE_CRM_ACTIVITY_LIMIT} weitere CRM Aktivitäten nicht inline angezeigt.`);
	}
	return lines.join("\n");
}

function renderCrmSignalsMarkdown(briefing: CompanyBriefing): string {
	const period = briefing.briefingPeriod;
	const periodLine = period.lastReachedCallAt
		? `• Last Reached Call: ${formatDateTimeForMarkdown(period.lastReachedCallAt)}.`
		: period.basis === "FALLBACK_60_DAYS"
			? "• Briefing Period nutzt den 60-Tage-Fallback."
			: "• Kein Last Reached Call gefunden.";
	const activitySignal = findCrmActivitySignal(briefing);
	if (!activitySignal) return `${periodLine}\n• CRM Signals sind nicht verfügbar.`;
	return `${periodLine}\n\n*${activitySignal.title}*\n${renderCrmActivityOverviewMarkdown(activitySignal)}`;
}

function renderNoticesMarkdown(notices: NoticeItem[]): string {
	if (notices.length === 0) return "• Keine Hinweise.";
	return notices
		.map((notice) => `• ${notice.severity} ${notice.code} (${notice.affectedBlock}): ${notice.message}`)
		.join("\n");
}

export function renderCompanyBriefingMarkdown(briefing: CompanyBriefing): string {
	const period = briefing.briefingPeriod;
	const basis =
		period.basis === "LAST_REACHED_CALL"
			? "seit Last Reached Call"
			: period.basis === "EXPLICIT"
				? "expliziter Zeitraum"
				: "60-Tage-Fallback";
	return [
		`*Company Briefing: ${sanitizeMarkdownText(briefing.companyName)}*`,
		"*Briefing Period*",
		`• ${formatDateTimeForMarkdown(period.from)} bis ${formatDateTimeForMarkdown(period.to)} (${basis})`,
		"*Executive Summary*",
		renderExecutiveSummary(briefing),
		"*Sales Opportunities*",
		"• Keine Sales Opportunities im V1-company_briefing-Tool enthalten.",
		"*Platform Signals*",
		renderPlatformSignalsMarkdown(briefing),
		"*CRM Signals*",
		renderCrmSignalsMarkdown(briefing),
		"*Hinweise / Datenlücken*",
		renderNoticesMarkdown(briefing.notices),
	].join("\n\n");
}

function renderBlockedResponseText(response: CompanyBriefingResponse): string {
	return [
		"*Company Briefing konnte nicht erstellt werden.*",
		"",
		...response.notices.map((notice) => `• ${notice.message}`),
	].join("\n");
}

function csvValue(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function renderJobofferDetailsCsv(joboffers: JobofferActivityOverviewItem[]): string {
	const header = [
		"joboffer_id",
		"title",
		"currently_active",
		"current_product",
		"current_product_since",
		"was_paid_in_period",
		"was_freemium_in_period",
		"new_bewerbungen_total",
		"new_bewerbungen_paid",
		"new_bewerbungen_freemium",
		"new_bewerbungen_other",
		"new_hires_total",
		"new_hires_paid",
		"new_hires_freemium",
		"new_hires_other",
		"is_expiring",
		"booking_ends_at",
		"previous_product_assignments",
	];
	const rows = joboffers.map((joboffer) => [
		joboffer.jobofferId,
		joboffer.title,
		joboffer.currentlyActive,
		joboffer.currentProduct,
		joboffer.currentProductSince,
		joboffer.wasPaidInPeriod,
		joboffer.wasFreemiumInPeriod,
		joboffer.newBewerbungenCount,
		joboffer.newPaidBewerbungenCount,
		joboffer.newFreemiumBewerbungenCount,
		joboffer.newOtherBewerbungenCount,
		joboffer.newHiresCount,
		joboffer.newPaidHiresCount,
		joboffer.newFreemiumHiresCount,
		joboffer.newOtherHiresCount,
		joboffer.isExpiring,
		joboffer.bookingEndsAt,
		JSON.stringify(joboffer.previousProductAssignments),
	]);
	return `${[header, ...rows].map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}

async function attachJobofferDetailsCsv(
	response: CompanyBriefingResponse,
	artifactHandler?: ArtifactHandler,
): Promise<boolean> {
	if (!artifactHandler || !response.briefing) return false;
	const jobofferSignal = findJobofferActivitySignal(response.briefing);
	const joboffers = jobofferSignal?.data.joboffers || [];
	if (joboffers.length === 0) return false;
	await artifactHandler({
		data: Buffer.from(renderJobofferDetailsCsv(joboffers), "utf-8"),
		name: `company_briefing_${response.companyId}_joboffers.csv`,
		title: "Company Briefing Joboffer Details CSV",
		mimeType: "text/csv",
	});
	return true;
}

export function createCompanyBriefingTool(
	args: CreateCompanyBriefingToolArgs,
): AgentTool<typeof companyBriefingSchema, CompanyBriefingResponse> {
	const services = createDefaultServices(args);
	return {
		name: COMPANY_BRIEFING_TOOL_NAME,
		label: "company_briefing",
		description:
			"Create a JobMatch Company Briefing from companyId. Use this tool for Company Briefings; do not reconstruct Company Briefings with arbitrary dbt/BI queries. Returns Slack-ready Markdown and structured, non-raw signal details.",
		parameters: companyBriefingSchema,
		execute: async (_toolCallId, params, signal) => {
			const input = validateCompanyBriefingArgs(params);
			const response = await executeCompanyBriefing(input, services, signal);
			const csvAttached = await attachJobofferDetailsCsv(response, args.artifactHandler);
			const text = response.markdown || renderBlockedResponseText(response);
			return {
				content: [
					{
						type: "text",
						text: csvAttached ? `${text}\n\n• Vollständige Joboffer-Detailtabelle als CSV angehängt.` : text,
					},
				],
				details: response,
			};
		},
	};
}

export function createWorkerToolsExtension(context: WorkerToolExtensionContext): AgentTool<any>[] {
	return [
		createCompanyBriefingTool({
			executor: context.executor,
			workspaceRoot: context.workspaceRoot,
			workingDir: context.workingDir,
			sessionDir: context.sessionDir,
			artifactHandler: context.artifactHandler,
		}),
	];
}

export default createWorkerToolsExtension;
