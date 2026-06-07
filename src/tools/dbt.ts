import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead, truncateTail } from "./truncate.js";

const DBT_ACTIONS = ["list", "show", "compile", "test", "parse"] as const;
type DbtAction = (typeof DBT_ACTIONS)[number];

const dbtSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're doing with dbt (shown to user)" }),
	action: Type.String({
		description: "dbt action: list, show, compile, test, or parse",
	}),
	select: Type.Optional(
		Type.String({
			description: "dbt selector expression, e.g. my_model, +my_model, path:analyses/playground/*",
		}),
	),
	inlineSql: Type.Optional(
		Type.String({
			description:
				"Inline SQL for dbt show, e.g. select * from {{ ref('my_model') }}. Do not include a trailing semicolon or SQL LIMIT; use limit instead.",
		}),
	),
	target: Type.Optional(Type.String({ description: "Optional dbt target override, e.g. dev, stage, prod" })),
	vars: Type.Optional(Type.String({ description: "Optional dbt vars string, usually YAML or JSON" })),
	limit: Type.Optional(Type.Number({ description: "Optional row limit for dbt show" })),
	output: Type.Optional(Type.String({ description: "Optional output mode, e.g. json for dbt list/show" })),
	jsonOutputPath: Type.Optional(
		Type.String({
			description:
				"Optional path for clean dbt show JSON output. If set, dbt show is forced to --output json and canonical { show: [...] } is written there.",
		}),
	),
	resourceTypes: Type.Optional(Type.Array(Type.String({ description: "dbt resource type" }))),
	defer: Type.Optional(Type.Boolean({ description: "Whether to pass --defer" })),
	state: Type.Optional(Type.String({ description: "Optional dbt state path used with --defer/--state" })),
	favorState: Type.Optional(Type.Boolean({ description: "Whether to pass --favor-state" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
});

interface DbtToolDetails {
	action: DbtAction;
	dbtExecutable: string;
	projectDir?: string;
	profilesDir?: string;
	target?: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	jsonOutputPath?: string;
	rowCount?: number;
	fields?: string[];
	fieldTypes?: Record<string, string>;
	sampleRows?: Record<string, unknown>[];
	fullJson?: { show: Record<string, unknown>[] };
	command: string;
}

interface DbtJsonSummary {
	jsonOutputPath: string;
	rowCount: number;
	fields: string[];
	fieldTypes: Record<string, string>;
	sampleRows: Record<string, unknown>[];
	fullJson?: { show: Record<string, unknown>[] };
	text: string;
}

const MAX_FULL_JSON_ROWS = 100;
const MAX_FULL_JSON_BYTES = 50 * 1024;

function readEnv(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name];
		if (value) return value;
	}
	return undefined;
}

function resolveIfPresent(baseDir: string, value: string | undefined): string | undefined {
	if (!value) return undefined;
	return resolve(baseDir, value);
}

function findNearestDbtProject(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		if (existsSync(join(current, "dbt_project.yml"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

function resolveDbtProjectDir(workspaceRoot: string, workingDir: string): string | undefined {
	const configured = resolveIfPresent(
		process.cwd(),
		readEnv("BEE_PI_AGENT_DBT_PROJECT_DIR", "PI_AGENT_WORKER_DBT_PROJECT_DIR"),
	);
	if (configured) return configured;

	return findNearestDbtProject(workingDir) || findNearestDbtProject(workspaceRoot);
}

function resolveDbtProfilesDir(projectDir: string | undefined): string | undefined {
	const configured = resolveIfPresent(
		process.cwd(),
		readEnv("BEE_PI_AGENT_DBT_PROFILES_DIR", "PI_AGENT_WORKER_DBT_PROFILES_DIR", "DBT_PROFILES_DIR"),
	);
	if (configured) return configured;
	if (projectDir && existsSync(join(projectDir, "profiles.yml"))) {
		return projectDir;
	}
	return undefined;
}

function resolveDbtExecutable(projectDir: string | undefined, workspaceRoot: string, workingDir: string): string {
	const configured = readEnv("BEE_PI_AGENT_DBT_COMMAND", "PI_AGENT_WORKER_DBT_COMMAND");
	if (configured) {
		return configured.includes("/") || configured.startsWith(".") ? resolve(process.cwd(), configured) : configured;
	}

	const candidates = [
		projectDir ? join(projectDir, ".venv", "bin", "dbt") : undefined,
		join(workingDir, ".venv", "bin", "dbt"),
		join(workspaceRoot, ".venv", "bin", "dbt"),
	].filter((value): value is string => Boolean(value));

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return "dbt";
}

function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `bee-pi-agent-dbt-${id}.log`);
}

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeInlineSql(value: string): string {
	return value.trim().replace(/;+\s*$/, "");
}

function assertDbtAction(value: string): DbtAction {
	if ((DBT_ACTIONS as readonly string[]).includes(value)) {
		return value as DbtAction;
	}
	throw new Error(`Unsupported dbt action '${value}'. Use one of: ${DBT_ACTIONS.join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDbtJsonRows(value: unknown): Record<string, unknown>[] | undefined {
	const rows = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.show)
			? value.show
			: isRecord(value) && Array.isArray(value.rows)
				? value.rows
				: isRecord(value) && Array.isArray(value.data)
					? value.data
					: undefined;
	if (!rows) return undefined;
	if (!rows.every(isRecord)) {
		throw new Error("dbt JSON payload must contain an array of row objects");
	}
	return rows;
}

interface DbtJsonMatch {
	rows: Record<string, unknown>[];
	hasShow: boolean;
}

function tryParseDbtJsonPayload(candidate: string): DbtJsonMatch | undefined {
	try {
		const parsed = JSON.parse(candidate) as unknown;
		const rows = normalizeDbtJsonRows(parsed);
		if (!rows) return undefined;
		return { rows, hasShow: isRecord(parsed) && Array.isArray(parsed.show) };
	} catch {
		return undefined;
	}
}

function pickDbtJsonMatch(matches: DbtJsonMatch[]): DbtJsonMatch {
	return [...matches].reverse().find((match) => match.hasShow) || matches[matches.length - 1];
}

function scanJsonCandidates(text: string): string[] {
	const candidates: string[] = [];
	let start = -1;
	let stack: string[] = [];
	let inString = false;
	let escaped = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (start < 0) {
			if (char === "{" || char === "[") {
				start = index;
				stack = [char === "{" ? "}" : "]"];
			}
			continue;
		}

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") {
			stack.push(char === "{" ? "}" : "]");
			continue;
		}
		if (char === "}" || char === "]") {
			if (stack.length === 0 || stack[stack.length - 1] !== char) {
				start = -1;
				stack = [];
				continue;
			}
			stack.pop();
			if (stack.length === 0) {
				candidates.push(text.slice(start, index + 1));
				start = -1;
			}
		}
	}

	return candidates;
}

export function extractDbtJsonRows(stdout: string, stderr = ""): Record<string, unknown>[] {
	const direct = tryParseDbtJsonPayload(stdout);
	if (direct) return direct.rows;

	const stdoutMatches = scanJsonCandidates(stdout)
		.map((candidate) => tryParseDbtJsonPayload(candidate))
		.filter((match): match is DbtJsonMatch => Boolean(match));
	if (stdoutMatches.length > 0) {
		return pickDbtJsonMatch(stdoutMatches).rows;
	}

	const combinedMatches = scanJsonCandidates(`${stdout}\n${stderr}`)
		.map((candidate) => tryParseDbtJsonPayload(candidate))
		.filter((match): match is DbtJsonMatch => Boolean(match));
	if (combinedMatches.length > 0) {
		return pickDbtJsonMatch(combinedMatches).rows;
	}

	throw new Error(
		"Could not extract clean dbt JSON payload. Expected stdout to contain JSON array or object with show/rows/data array.",
	);
}

function getFieldType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function summarizeRows(rows: Record<string, unknown>[], jsonOutputPath: string): DbtJsonSummary {
	const fields = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	const fieldTypes = Object.fromEntries(
		fields.map((field) => {
			const types = Array.from(new Set(rows.map((row) => getFieldType(row[field]))));
			return [field, types.join("|")];
		}),
	);
	const sampleRows = rows.slice(0, 5);
	const canonical = { show: rows };
	const canonicalText = JSON.stringify(canonical, null, 2);
	const includeFullJson =
		rows.length <= MAX_FULL_JSON_ROWS && Buffer.byteLength(canonicalText, "utf-8") <= MAX_FULL_JSON_BYTES;
	const lines = [
		`Wrote clean dbt JSON output: ${jsonOutputPath}`,
		`Rows: ${rows.length}`,
		`Fields: ${fields.length > 0 ? fields.join(", ") : "(none)"}`,
		`Field types: ${JSON.stringify(fieldTypes)}`,
		`Sample rows: ${JSON.stringify(sampleRows)}`,
	];
	if (includeFullJson) {
		lines.push(`Full JSON (${rows.length} rows):\n${canonicalText}`);
	} else {
		lines.push(
			`Full JSON omitted from tool result because it exceeds ${MAX_FULL_JSON_ROWS} rows or ${MAX_FULL_JSON_BYTES} bytes.`,
		);
	}
	return {
		jsonOutputPath,
		rowCount: rows.length,
		fields,
		fieldTypes,
		sampleRows,
		fullJson: includeFullJson ? canonical : undefined,
		text: lines.join("\n"),
	};
}

function resolveJsonOutputPath(value: string | undefined, workingDir: string, sessionDir: string): string {
	if (value) return isAbsolute(value) ? value : resolve(workingDir, value);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const shortId = randomBytes(4).toString("hex");
	return join(sessionDir, "outputs", `dbt-show-${timestamp}-${shortId}.json`);
}

async function writeCanonicalDbtJson(rows: Record<string, unknown>[], outputPath: string): Promise<void> {
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify({ show: rows }, null, 2)}\n`, "utf-8");
}

function buildDbtCommand(args: {
	dbtExecutable: string;
	projectDir?: string;
	profilesDir?: string;
	action: DbtAction;
	select?: string;
	inlineSql?: string;
	target?: string;
	vars?: string;
	limit?: number;
	output?: string;
	resourceTypes?: string[];
	defer?: boolean;
	state?: string;
	favorState?: boolean;
}): string {
	const command: string[] = [shellEscape(args.dbtExecutable)];

	if (args.projectDir) {
		command.push("--project-dir", shellEscape(args.projectDir));
	}
	if (args.profilesDir) {
		command.push("--profiles-dir", shellEscape(args.profilesDir));
	}

	command.push(args.action);

	if (args.target) {
		command.push("--target", shellEscape(args.target));
	}
	if (args.vars) {
		command.push("--vars", shellEscape(args.vars));
	}
	if (args.output) {
		command.push("--output", shellEscape(args.output));
	}
	if (args.defer) {
		command.push("--defer");
	}
	if (args.state) {
		command.push("--state", shellEscape(args.state));
	}
	if (args.favorState) {
		command.push("--favor-state");
	}

	if (args.action === "show") {
		if (args.inlineSql) {
			command.push("--inline", shellEscape(normalizeInlineSql(args.inlineSql)));
		} else if (args.select) {
			command.push("--select", shellEscape(args.select));
		} else {
			throw new Error("dbt show requires either select or inlineSql");
		}

		if (args.limit !== undefined) {
			command.push("--limit", String(args.limit));
		}
		return command.join(" ");
	}

	if (args.action === "parse") {
		return command.join(" ");
	}

	if (!args.select) {
		throw new Error(`dbt ${args.action} requires select`);
	}

	command.push("--select", shellEscape(args.select));

	if (args.resourceTypes && args.resourceTypes.length > 0) {
		for (const resourceType of args.resourceTypes) {
			command.push("--resource-type", shellEscape(resourceType));
		}
	}

	if (args.action === "compile" || args.action === "test") {
		command.push("--quiet");
		command.push("--warn-error-options", shellEscape('{"error": ["NoNodesForSelectionCriteria"]}'));
	}

	return command.join(" ");
}

function extractOutputText(action: DbtAction, output: string): { text: string; truncation: TruncationResult } {
	const truncation = action === "show" || action === "list" ? truncateHead(output) : truncateTail(output);
	return {
		text: truncation.content || "(no output)",
		truncation,
	};
}

export function createDbtTool(
	executor: Executor,
	workspaceRoot: string,
	workingDir: string,
	sessionDir = workingDir,
): AgentTool<typeof dbtSchema> {
	return {
		name: "dbt",
		label: "dbt",
		description:
			"Run dbt commands for model discovery, compilation, tests, and inline SQL preview. Supports list/show/compile/test/parse. Does not support dbt build or dbt run; analytics queries should use already-built prod models. Configure BEE_PI_AGENT_DBT_PROJECT_DIR and optionally BEE_PI_AGENT_DBT_COMMAND / BEE_PI_AGENT_DBT_PROFILES_DIR.",
		parameters: dbtSchema,
		execute: async (
			_toolCallId: string,
			{
				action,
				select,
				inlineSql,
				target,
				vars,
				limit,
				output,
				jsonOutputPath,
				resourceTypes,
				defer,
				state,
				favorState,
				timeout,
			}: {
				label: string;
				action: string;
				select?: string;
				inlineSql?: string;
				target?: string;
				vars?: string;
				limit?: number;
				output?: string;
				jsonOutputPath?: string;
				resourceTypes?: string[];
				defer?: boolean;
				state?: string;
				favorState?: boolean;
				timeout?: number;
			},
			signal?: AbortSignal,
		) => {
			const resolvedAction = assertDbtAction(action);
			const shouldWriteJson = resolvedAction === "show" && (jsonOutputPath !== undefined || output === "json");
			const effectiveOutput = shouldWriteJson ? "json" : output;
			const projectDir = resolveDbtProjectDir(workspaceRoot, workingDir);
			const profilesDir = resolveDbtProfilesDir(projectDir);
			const dbtExecutable = resolveDbtExecutable(projectDir, workspaceRoot, workingDir);
			const resolvedTarget = target || readEnv("BEE_PI_AGENT_DBT_TARGET", "PI_AGENT_WORKER_DBT_TARGET");
			const command = buildDbtCommand({
				dbtExecutable,
				projectDir,
				profilesDir,
				action: resolvedAction,
				select,
				inlineSql,
				target: resolvedTarget,
				vars,
				limit,
				output: effectiveOutput,
				resourceTypes,
				defer,
				state,
				favorState,
			});

			const result = await executor.exec(command, { timeout, signal });
			let combinedOutput = "";
			if (result.stdout) combinedOutput += result.stdout;
			if (result.stderr) {
				if (combinedOutput) combinedOutput += "\n";
				combinedOutput += result.stderr;
			}

			let fullOutputPath: string | undefined;
			if (Buffer.byteLength(combinedOutput, "utf-8") > DEFAULT_MAX_BYTES) {
				fullOutputPath = getTempFilePath();
				await writeFile(fullOutputPath, combinedOutput, "utf-8");
			}

			const truncated = extractOutputText(resolvedAction, combinedOutput || "");
			if (truncated.truncation.truncated && !fullOutputPath) {
				fullOutputPath = getTempFilePath();
				await writeFile(fullOutputPath, combinedOutput, "utf-8");
			}
			let text = truncated.text;
			if (truncated.truncation.truncated && fullOutputPath) {
				if (resolvedAction === "show" || resolvedAction === "list") {
					const endLine = truncated.truncation.outputLines;
					text += `\n\n[Showing first ${endLine} lines of ${truncated.truncation.totalLines} (${formatSize(truncated.truncation.outputBytes)} shown). Full output: ${fullOutputPath}]`;
				} else if (truncated.truncation.lastLinePartial) {
					text += `\n\n[Showing last ${formatSize(truncated.truncation.outputBytes)} of command output. Full output: ${fullOutputPath}]`;
				} else {
					const startLine = truncated.truncation.totalLines - truncated.truncation.outputLines + 1;
					const endLine = truncated.truncation.totalLines;
					text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncated.truncation.totalLines}. Full output: ${fullOutputPath}]`;
				}
			}

			if (result.code !== 0) {
				throw new Error(
					[
						text,
						`dbt command failed with exit code ${result.code}`,
						`command: ${command}`,
						projectDir ? `projectDir: ${projectDir}` : "projectDir: (not resolved)",
						dbtExecutable === "dbt"
							? "hint: configure BEE_PI_AGENT_DBT_COMMAND if dbt is not on PATH"
							: undefined,
					]
						.filter(Boolean)
						.join("\n\n"),
				);
			}

			let jsonSummary: DbtJsonSummary | undefined;
			if (shouldWriteJson) {
				const resolvedJsonOutputPath = resolveJsonOutputPath(jsonOutputPath, workingDir, sessionDir);
				const rows = extractDbtJsonRows(result.stdout || "", result.stderr || "");
				await writeCanonicalDbtJson(rows, resolvedJsonOutputPath);
				const details = await stat(resolvedJsonOutputPath);
				jsonSummary = summarizeRows(rows, resolvedJsonOutputPath);
				text = `${jsonSummary.text}\nJSON file size: ${formatSize(details.size)}`;
			}

			const details: DbtToolDetails = {
				action: resolvedAction,
				dbtExecutable,
				projectDir,
				profilesDir,
				target: resolvedTarget,
				truncation: shouldWriteJson ? undefined : truncated.truncation.truncated ? truncated.truncation : undefined,
				fullOutputPath,
				jsonOutputPath: jsonSummary?.jsonOutputPath,
				rowCount: jsonSummary?.rowCount,
				fields: jsonSummary?.fields,
				fieldTypes: jsonSummary?.fieldTypes,
				sampleRows: jsonSummary?.sampleRows,
				fullJson: jsonSummary?.fullJson,
				command,
			};

			return {
				content: [{ type: "text", text }],
				details,
			};
		},
	};
}
