import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Executor } from "../sandbox.js";
import type { WorkerRunRequest } from "../types.js";
import { type ArtifactHandler, createAttachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createChartTool } from "./chart.js";
import { createDbtTool } from "./dbt.js";
import { createEditTool } from "./edit.js";
import { loadWorkerToolExtensions } from "./extensions.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export interface CreateWorkerToolsArgs {
	executor: Executor;
	artifactHandler: ArtifactHandler;
	request: WorkerRunRequest;
	workspaceRoot: string;
	workingDir: string;
	stateDir: string;
	sessionDir: string;
}

export async function createWorkerTools(args: CreateWorkerToolsArgs): Promise<AgentTool<any>[]> {
	const builtinTools = [
		createReadTool(args.executor),
		createBashTool(args.executor),
		createEditTool(args.executor),
		createWriteTool(args.executor),
		createAttachTool(args.artifactHandler),
		createDbtTool(args.executor, args.workspaceRoot, args.workingDir, args.sessionDir),
		createChartTool(args.sessionDir),
	];

	const extensionTools = await loadWorkerToolExtensions({
		executor: args.executor,
		request: args.request,
		workspaceRoot: args.workspaceRoot,
		workingDir: args.workingDir,
		stateDir: args.stateDir,
		sessionDir: args.sessionDir,
	});

	return [...builtinTools, ...extensionTools];
}
