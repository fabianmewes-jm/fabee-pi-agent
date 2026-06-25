import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Executor } from "../sandbox.js";
import type { WorkerRunRequest } from "../types.js";
import { type ArtifactHandler, createAttachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createChartTool } from "./chart.js";
import { createCompanyBriefingTool, isCompanyBriefingEnvEnabled } from "./company-briefing.js";
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
	const builtinTools: AgentTool<any>[] = [
		createReadTool(args.executor),
		createBashTool(args.executor),
		createEditTool(args.executor),
		createWriteTool(args.executor),
		createAttachTool(args.artifactHandler),
		createDbtTool(args.executor, args.workspaceRoot, args.workingDir, args.sessionDir),
		createChartTool(args.sessionDir),
	];

	if (isCompanyBriefingEnvEnabled()) {
		builtinTools.push(
			createCompanyBriefingTool({
				executor: args.executor,
				workspaceRoot: args.workspaceRoot,
				workingDir: args.workingDir,
				sessionDir: args.sessionDir,
				artifactHandler: args.artifactHandler,
			}),
		);
	}

	const extensionTools = await loadWorkerToolExtensions({
		executor: args.executor,
		artifactHandler: args.artifactHandler,
		request: args.request,
		workspaceRoot: args.workspaceRoot,
		workingDir: args.workingDir,
		stateDir: args.stateDir,
		sessionDir: args.sessionDir,
	});

	return [...builtinTools, ...extensionTools];
}
