import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Executor } from "../sandbox.js";
import type { WorkerRunRequest } from "../types.js";
import { type ArtifactHandler, createAttachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createChartTool } from "./chart.js";
import { createCompanyBriefingTool } from "./company-briefing.js";
import { createDbtTool } from "./dbt.js";
import { createEditTool } from "./edit.js";
import { loadWorkerToolExtensions } from "./extensions.js";
import { createMarketInsightsTool, isMarketInsightsConfigured } from "./market-insights.js";
import { createOutputPathGuard } from "./output-path.js";
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
	const outputRoot = join(args.sessionDir, "outputs");
	const outputPaths = createOutputPathGuard(outputRoot);
	const taskLogDir = process.env.BEE_PI_AGENT_TASK_LOG_DIR?.trim();
	const writePaths = createOutputPathGuard(outputRoot, taskLogDir ? [taskLogDir] : []);
	const builtinTools: AgentTool<any>[] = [
		createReadTool(args.executor),
		createBashTool(args.executor),
		createEditTool(args.executor, outputPaths),
		createWriteTool(args.executor, writePaths),
		createAttachTool(args.artifactHandler),
		createDbtTool(args.executor, args.workspaceRoot, args.workingDir, args.sessionDir),
		createChartTool(args.sessionDir),
		createCompanyBriefingTool({
			executor: args.executor,
			workspaceRoot: args.workspaceRoot,
			workingDir: args.workingDir,
			sessionDir: args.sessionDir,
			artifactHandler: args.artifactHandler,
		}),
	];

	if (isMarketInsightsConfigured()) builtinTools.push(createMarketInsightsTool());

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
