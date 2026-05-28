import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import type { WorkerRunRequest } from "../types.js";
export interface WorkerToolExtensionContext {
	executor: Executor;
	request: WorkerRunRequest;
	workspaceRoot: string;
	workingDir: string;
	stateDir: string;
	sessionDir: string;
}

type ToolFactoryResult = AgentTool<any>[] | AgentTool<any> | { tools?: AgentTool<any>[] } | undefined;
type ToolFactory = (context: WorkerToolExtensionContext) => Promise<ToolFactoryResult> | ToolFactoryResult;

function isToolCollection(result: ToolFactoryResult): result is { tools?: AgentTool<any>[] } {
	return typeof result === "object" && result !== null && "tools" in result;
}

function isAgentToolValue(result: ToolFactoryResult): result is AgentTool<any> {
	return (
		typeof result === "object" &&
		result !== null &&
		"name" in result &&
		typeof result.name === "string" &&
		"description" in result &&
		typeof result.description === "string" &&
		"execute" in result &&
		typeof result.execute === "function"
	);
}

function getToolModuleSpecs(): string[] {
	const raw = process.env.BEE_PI_AGENT_TOOL_MODULES || process.env.PI_AGENT_WORKER_TOOL_MODULES;
	if (!raw) return [];
	return raw
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

function resolveToolModuleSpecifier(specifier: string): string {
	if (specifier.startsWith("file://")) return specifier;
	if (specifier.startsWith(".") || isAbsolute(specifier)) {
		return pathToFileURL(resolve(specifier)).href;
	}
	return specifier;
}

function resolveToolFactory(moduleValue: unknown): ToolFactory | undefined {
	if (!moduleValue || typeof moduleValue !== "object") return undefined;

	const candidate = moduleValue as {
		createWorkerToolsExtension?: unknown;
		createWorkerTools?: unknown;
		default?: unknown;
	};

	if (typeof candidate.createWorkerToolsExtension === "function") {
		return candidate.createWorkerToolsExtension as ToolFactory;
	}
	if (typeof candidate.createWorkerTools === "function") {
		return candidate.createWorkerTools as ToolFactory;
	}
	if (typeof candidate.default === "function") {
		return candidate.default as ToolFactory;
	}
	if (
		candidate.default &&
		typeof candidate.default === "object" &&
		typeof (candidate.default as { createWorkerToolsExtension?: unknown }).createWorkerToolsExtension === "function"
	) {
		return (candidate.default as { createWorkerToolsExtension: ToolFactory }).createWorkerToolsExtension;
	}
	return undefined;
}

function normalizeToolFactoryResult(result: ToolFactoryResult): AgentTool<any>[] {
	if (!result) return [];
	if (Array.isArray(result)) return result;
	if (isToolCollection(result) && Array.isArray(result.tools)) return result.tools;
	if (!isAgentToolValue(result)) {
		throw new Error("Tool module factory must return an AgentTool, AgentTool[], or { tools: AgentTool[] }");
	}
	return [result];
}

export async function loadWorkerToolExtensions(context: WorkerToolExtensionContext): Promise<AgentTool<any>[]> {
	const specs = getToolModuleSpecs();
	const tools: AgentTool<any>[] = [];

	for (const spec of specs) {
		const moduleValue = await import(resolveToolModuleSpecifier(spec));
		const factory = resolveToolFactory(moduleValue);
		if (!factory) {
			throw new Error(
				`Tool module '${spec}' must export createWorkerToolsExtension, createWorkerTools, or a default function`,
			);
		}
		const result = await factory(context);
		tools.push(...normalizeToolFactoryResult(result));
	}

	return tools;
}
