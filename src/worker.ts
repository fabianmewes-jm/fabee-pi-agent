import { Agent, type AgentEvent, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { createWorkerBlobStore } from "./blob-store.js";
import { createWorkerSettingsManager, syncLogToSessionManager } from "./context.js";
import * as log from "./log.js";
import { createExecutor, parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { createWorkerTools } from "./tools/index.js";
import type {
	InternalWorkerRunRequest,
	WorkerArtifactRef,
	WorkerEventSink,
	WorkerRunEvent,
	WorkerRunRequest,
	WorkerRuntimeConfig,
	WorkerUsageSummary,
} from "./types.js";

const DEFAULT_ANTHROPIC_PROVIDER = "anthropic";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
const DEFAULT_OPENAI_PROVIDER = "openai";
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_OPENAI_CODEX_PROVIDER = "openai-codex";
const DEFAULT_OPENAI_CODEX_MODEL = "gpt-5.5";
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "off";
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function getWorkerAuthPath(): string {
	const explicitPath =
		process.env.BEE_PI_AGENT_AUTH_FILE || process.env.PI_AGENT_WORKER_AUTH_FILE || process.env.MOM_AUTH_FILE;
	if (explicitPath) return explicitPath;

	const workerAuthPath = join(homedir(), ".pi", "agent-worker", "auth.json");
	if (existsSync(workerAuthPath)) return workerAuthPath;

	const agentAuthPath = join(homedir(), ".pi", "agent", "auth.json");
	if (existsSync(agentAuthPath)) return agentAuthPath;

	const momAuthPath = join(homedir(), ".pi", "mom", "auth.json");
	if (existsSync(momAuthPath)) return momAuthPath;

	return workerAuthPath;
}

function resolveModelConfig(modelRegistry: ModelRegistry, runtimeConfig: WorkerRuntimeConfig): Model<Api> {
	const explicitProvider =
		runtimeConfig.model?.provider ||
		process.env.BEE_PI_AGENT_MODEL_PROVIDER ||
		process.env.PI_AGENT_WORKER_MODEL_PROVIDER ||
		process.env.MOM_MODEL_PROVIDER;
	const explicitModelId =
		runtimeConfig.model?.modelId ||
		process.env.BEE_PI_AGENT_MODEL_ID ||
		process.env.PI_AGENT_WORKER_MODEL_ID ||
		process.env.MOM_MODEL_ID;

	const resolveModelConfigById = (provider: string, modelId: string) => {
		const resolved = modelRegistry.find(provider, modelId);
		if (!resolved) {
			throw new Error(`Configured model not found: provider=${provider}, model=${modelId}`);
		}
		return resolved;
	};

	if (explicitProvider || explicitModelId) {
		const provider = explicitProvider || DEFAULT_ANTHROPIC_PROVIDER;
		let modelId = explicitModelId;
		if (!modelId) {
			if (provider === DEFAULT_OPENAI_PROVIDER) {
				modelId =
					process.env.BEE_PI_AGENT_OPENAI_MODEL ||
					process.env.PI_AGENT_WORKER_OPENAI_MODEL ||
					process.env.MOM_OPENAI_MODEL ||
					process.env.OPENAI_MODEL ||
					DEFAULT_OPENAI_MODEL;
			} else if (provider === DEFAULT_OPENAI_CODEX_PROVIDER) {
				modelId =
					process.env.BEE_PI_AGENT_OPENAI_MODEL ||
					process.env.PI_AGENT_WORKER_OPENAI_MODEL ||
					process.env.MOM_OPENAI_MODEL ||
					process.env.OPENAI_MODEL ||
					DEFAULT_OPENAI_CODEX_MODEL;
			} else if (provider === DEFAULT_ANTHROPIC_PROVIDER) {
				modelId = DEFAULT_ANTHROPIC_MODEL;
			}
		}

		if (!modelId) {
			throw new Error(`Missing model id for provider ${provider}. Set BEE_PI_AGENT_MODEL_ID.`);
		}
		return resolveModelConfigById(provider, modelId);
	}

	const openAiModelId =
		process.env.BEE_PI_AGENT_OPENAI_MODEL ||
		process.env.PI_AGENT_WORKER_OPENAI_MODEL ||
		process.env.MOM_OPENAI_MODEL ||
		process.env.OPENAI_MODEL ||
		DEFAULT_OPENAI_MODEL;
	if (modelRegistry.authStorage.hasAuth(DEFAULT_OPENAI_CODEX_PROVIDER)) {
		return resolveModelConfigById(
			DEFAULT_OPENAI_CODEX_PROVIDER,
			process.env.BEE_PI_AGENT_OPENAI_MODEL ||
				process.env.PI_AGENT_WORKER_OPENAI_MODEL ||
				process.env.MOM_OPENAI_MODEL ||
				process.env.OPENAI_MODEL ||
				DEFAULT_OPENAI_CODEX_MODEL,
		);
	}

	if (modelRegistry.authStorage.hasAuth(DEFAULT_OPENAI_PROVIDER)) {
		return resolveModelConfigById(DEFAULT_OPENAI_PROVIDER, openAiModelId);
	}

	return resolveModelConfigById(DEFAULT_ANTHROPIC_PROVIDER, DEFAULT_ANTHROPIC_MODEL);
}

async function getModelApiKey(modelRegistry: ModelRegistry, model: Model<Api>, authPath: string): Promise<string> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(
			`${auth.error}\n\n` +
				`Configure credentials via environment/auth file, or login with npx @earendil-works/pi-ai login ${model.provider} and store the resulting auth.json at ${authPath}`,
		);
	}
	if (!auth.apiKey) {
		throw new Error(
			`No API key found for ${model.provider}.\n\n` +
				`Configure credentials via environment/auth file, or login with npx @earendil-works/pi-ai login ${model.provider} and store the resulting auth.json at ${authPath}`,
		);
	}
	return auth.apiKey;
}

function getWorkerThinkingLevel(): ThinkingLevel {
	const configured =
		process.env.BEE_PI_AGENT_THINKING_LEVEL ||
		process.env.PI_AGENT_WORKER_THINKING_LEVEL ||
		process.env.MOM_THINKING_LEVEL;
	if (!configured) return DEFAULT_THINKING_LEVEL;

	if (!THINKING_LEVELS.has(configured as ThinkingLevel)) {
		throw new Error(
			`Invalid thinking level ${configured}. Expected one of: ${Array.from(THINKING_LEVELS).join(", ")}`,
		);
	}
	return configured as ThinkingLevel;
}

function getMemory(runtimeConfig: WorkerRuntimeConfig): string {
	const parts: string[] = [];
	const memoryPath = runtimeConfig.workspace.memoryFile || join(runtimeConfig.workspace.rootDir, "MEMORY.md");
	if (existsSync(memoryPath)) {
		const content = readFileSync(memoryPath, "utf-8").trim();
		if (content) {
			parts.push(content);
		}
	}
	return parts.length > 0 ? parts.join("\n\n") : "(no working memory yet)";
}

function translateWorkspacePath(hostPath: string, workspaceRoot: string, visibleWorkspacePath: string): string {
	if (hostPath.startsWith(workspaceRoot)) {
		return visibleWorkspacePath + hostPath.slice(workspaceRoot.length);
	}
	return hostPath;
}

function buildSystemPrompt(
	request: InternalWorkerRunRequest,
	runtimeConfig: WorkerRuntimeConfig,
	visibleWorkspacePath: string,
	memory: string,
	tools: AgentTool<any>[],
): string {
	const currentDir = runtimeConfig.workspace.cwd || runtimeConfig.workspace.rootDir;
	const attachmentsSection =
		request.attachments && request.attachments.length > 0
			? request.attachments
					.map((attachment) => `- ${attachment.name || attachment.title || attachment.attachmentId}`)
					.join("\n")
			: "(no non-image attachments)";

	const requestedBy = request.actor.displayName || request.actor.userName || request.actor.userId || "unknown";

	return `You are pi-agent-worker, a concise coding and operations assistant. No emojis.

## Run Context
- run id: ${request.runId}
- session id: ${request.sessionId}
- requested by: ${requestedBy}
- working directory: ${currentDir}
- workspace root: ${visibleWorkspacePath}

## Behavior
- Be concise and operational.
- Prefer direct answers and concrete actions.
- Treat the workspace as persistent project state.
- Use tools rather than guessing when file or shell context matters.
- For dbt operations, especially dbt show --inline, always use the prod target (--target prod / tool parameter target: "prod") and never use the dev target unless the user explicitly overrides this for a specific command.

## Workspace Layout
${visibleWorkspacePath}/
├── MEMORY.md                     # Optional long-lived memory
├── skills/                       # Optional reusable skills
└── .pi-agent-worker/             # Default worker state directory
    ├── sessions/
    └── logs/

## Memory
${memory}

## Attachments
Images are attached directly to the model request when possible.
Other attachments are available at:
${attachmentsSection}

## Tools
${tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}

Every tool requires a "label" parameter because the caller surfaces it to users.`;
}

function assertUniqueToolNames(tools: AgentTool<any>[]): void {
	const seen = new Set<string>();
	for (const tool of tools) {
		if (seen.has(tool.name)) {
			throw new Error(`Duplicate worker tool name registered: ${tool.name}`);
		}
		seen.add(tool.name);
	}
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) return textParts.join("\n");
	}

	return JSON.stringify(result);
}

function formatUserMessage(request: WorkerRunRequest, nonImagePaths: string[]): string {
	const now = new Date();
	const pad = (n: number) => n.toString().padStart(2, "0");
	const offset = -now.getTimezoneOffset();
	const offsetSign = offset >= 0 ? "+" : "-";
	const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
	const offsetMins = pad(Math.abs(offset) % 60);
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;

	const userName = request.actor.userName || request.actor.displayName || request.actor.userId || "unknown";
	let message = `[${timestamp}] [${userName}]: ${request.message.text}`;

	if (nonImagePaths.length > 0) {
		message += `\n\n<attachments>\n${nonImagePaths.join("\n")}\n</attachments>`;
	}

	return message;
}

function ensureAbsolutePath(baseDir: string, value: string): string {
	return isAbsolute(value) ? value : resolve(baseDir, value);
}

function buildUsageSummary(messages: AgentSession["messages"], model: Model<Api>): WorkerUsageSummary | undefined {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let costInput = 0;
	let costOutput = 0;
	let costCacheRead = 0;
	let costCacheWrite = 0;
	let costTotal = 0;

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = (message as any).usage;
		if (!usage) continue;
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		costInput += usage.cost.input;
		costOutput += usage.cost.output;
		costCacheRead += usage.cost.cacheRead;
		costCacheWrite += usage.cost.cacheWrite;
		costTotal += usage.cost.total;
	}

	if (costTotal === 0) return undefined;

	const lastAssistantMessage = [...messages]
		.reverse()
		.find((message) => message.role === "assistant" && (message as any).stopReason !== "aborted") as any;

	const contextTokens = lastAssistantMessage
		? lastAssistantMessage.usage.input +
			lastAssistantMessage.usage.output +
			lastAssistantMessage.usage.cacheRead +
			lastAssistantMessage.usage.cacheWrite
		: undefined;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost: {
			input: costInput,
			output: costOutput,
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			total: costTotal,
		},
		contextTokens,
		contextWindow: model.contextWindow || 200000,
	};
}

type EmittableWorkerRunEvent = WorkerRunEvent;

async function emit(eventSink: WorkerEventSink, event: EmittableWorkerRunEvent): Promise<void> {
	await eventSink(event);
}

function appendJsonlLine(targetPath: string, value: unknown): Promise<void> {
	return appendFile(targetPath, `${JSON.stringify(value)}\n`, "utf-8");
}

function assertRunRequest(request: unknown): asserts request is InternalWorkerRunRequest {
	if (!request || typeof request !== "object") throw new Error("Request body must be a JSON object");
	const candidate = request as Partial<InternalWorkerRunRequest>;
	if (!candidate.runId) throw new Error("Missing runId");
	if (!candidate.sessionId) throw new Error("Missing sessionId");
	if (!candidate.message?.text) throw new Error("Missing message.text");
	if (!candidate.actor?.userId) throw new Error("Missing actor.userId");
	if (!candidate.conversation?.conversationId) throw new Error("Missing conversation.conversationId");
}

export async function runWorker(
	requestValue: unknown,
	runtimeConfig: WorkerRuntimeConfig,
	eventSink: WorkerEventSink,
	abortSignal?: AbortSignal,
): Promise<void> {
	assertRunRequest(requestValue);
	const request = requestValue;

	const logCtx = { runId: request.runId, sessionId: request.sessionId };
	const workspaceRoot = ensureAbsolutePath(process.cwd(), runtimeConfig.workspace.rootDir);
	const workingDir = ensureAbsolutePath(workspaceRoot, runtimeConfig.workspace.cwd || ".");
	const stateDir = ensureAbsolutePath(workspaceRoot, runtimeConfig.workspace.stateDir || ".bee-pi-agent");
	const sessionDir = join(stateDir, "sessions", request.sessionId);
	const logDir = join(stateDir, "logs");
	const requestLogPath = join(logDir, `${request.runId}.jsonl`);

	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });

	const sandbox =
		runtimeConfig.sandbox?.type === "docker"
			? parseSandboxArg(
					`docker:${runtimeConfig.sandbox.container}`,
					runtimeConfig.sandbox.workspaceRoot || "/workspace",
				)
			: ({ type: "host" } satisfies SandboxConfig);
	await validateSandbox(sandbox);

	const executor = createExecutor(
		sandbox,
		workingDir,
		runtimeConfig.sandbox?.type === "docker"
			? ensureAbsolutePath(runtimeConfig.sandbox.workspaceRoot || "/workspace", runtimeConfig.workspace.cwd || ".")
			: workingDir,
	);
	const visibleWorkspacePath = executor.getWorkspacePath(workspaceRoot);
	const authPath = getWorkerAuthPath();
	const agentDir = dirname(authPath);
	const authStorage = AuthStorage.create(authPath);
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const resolvedRuntimeConfig: WorkerRuntimeConfig = {
		...runtimeConfig,
		workspace: {
			...runtimeConfig.workspace,
			rootDir: workspaceRoot,
			cwd: workingDir,
			stateDir,
		},
		blobStore: {
			rootDir: ensureAbsolutePath(process.cwd(), runtimeConfig.blobStore.rootDir),
		},
	};
	const blobStore = createWorkerBlobStore(resolvedRuntimeConfig);
	const pendingArtifacts: WorkerArtifactRef[] = [];
	const flushPendingArtifacts = async () => {
		for (const artifact of pendingArtifacts.splice(0)) {
			await emit(eventSink, { type: "artifact.created", runId: request.runId, artifact });
		}
	};
	const model = resolveModelConfig(modelRegistry, resolvedRuntimeConfig);
	const memory = getMemory(resolvedRuntimeConfig);
	const tools = await createWorkerTools({
		executor,
		artifactHandler: async (input) => {
			const isBufferArtifact = "data" in input;
			const artifact = await blobStore.putArtifact({
				namespace: `artifacts/${request.sessionId}/${request.runId}`,
				filePath: isBufferArtifact ? undefined : input.path,
				data: isBufferArtifact ? input.data : undefined,
				name: input.name || (isBufferArtifact ? undefined : basename(input.path)),
				title: input.title,
				mimeType: input.mimeType,
			});
			pendingArtifacts.push(artifact);
		},
		request,
		workspaceRoot,
		workingDir,
		stateDir,
		sessionDir,
	});
	assertUniqueToolNames(tools);
	const systemPrompt = buildSystemPrompt(request, resolvedRuntimeConfig, visibleWorkspacePath, memory, tools);

	const contextFile = join(sessionDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, workingDir);
	const settingsManager = createWorkerSettingsManager(stateDir);
	const workspaceSkillsDir =
		resolvedRuntimeConfig.workspace.skillsDir || join(resolvedRuntimeConfig.workspace.rootDir, "skills");
	const resourceLoader = new DefaultResourceLoader({
		cwd: workingDir,
		agentDir,
		settingsManager,
		additionalSkillPaths: existsSync(workspaceSkillsDir) ? [workspaceSkillsDir] : [],
		noExtensions: true,
		noThemes: true,
		systemPrompt,
		appendSystemPrompt: resolvedRuntimeConfig.systemPromptAppend
			? [resolvedRuntimeConfig.systemPromptAppend]
			: undefined,
		skillsOverride: (base) => ({
			skills: base.skills.map((skill) => ({
				...skill,
				filePath: translateWorkspacePath(
					skill.filePath,
					resolvedRuntimeConfig.workspace.rootDir,
					visibleWorkspacePath,
				),
				baseDir: translateWorkspacePath(
					skill.baseDir,
					resolvedRuntimeConfig.workspace.rootDir,
					visibleWorkspacePath,
				),
			})),
			diagnostics: base.diagnostics,
		}),
	});
	await resourceLoader.reload();

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: getWorkerThinkingLevel(),
			tools,
		},
		convertToLlm,
		getApiKey: async () => getModelApiKey(modelRegistry, model, authPath),
	});

	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.state.messages = loadedSession.messages;
	}

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: workingDir,
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	const pendingTools = new Map<string, { toolName: string; args: Record<string, unknown>; startTime: number }>();
	const syncedCount = syncLogToSessionManager(sessionManager, sessionDir);
	if (syncedCount > 0) {
		agent.state.messages = sessionManager.buildSessionContext().messages;
	}

	let stopReason = "stop";
	let errorMessage: string | undefined;

	session.subscribe(async (event) => {
		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as Record<string, unknown> & { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args,
				startTime: Date.now(),
			});

			await emit(eventSink, {
				type: "tool.started",
				runId: request.runId,
				toolName: agentEvent.toolName,
				label,
				args,
			});
			return;
		}

		if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);
			const durationMs = pending ? Date.now() - pending.startTime : 0;

			await emit(eventSink, {
				type: "tool.completed",
				runId: request.runId,
				toolName: agentEvent.toolName,
				success: !agentEvent.isError,
				durationMs,
				result: extractToolResultText(agentEvent.result),
				label: pending?.args.label as string | undefined,
				args: pending?.args,
			});
			return;
		}

		if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role !== "assistant") return;

			const assistantMsg = agentEvent.message as any;
			if (assistantMsg.stopReason) stopReason = assistantMsg.stopReason;
			if (assistantMsg.errorMessage) errorMessage = assistantMsg.errorMessage;

			// Do not forward intermediate assistant/thinking messages to the gateway.
			// The final assistant answer is emitted once after session.prompt() completes.
			return;
		}

		if (event.type === "compaction_start") {
			await emit(eventSink, {
				type: "run.compaction",
				runId: request.runId,
				message: `Compaction started (${event.reason})`,
			});
			return;
		}

		if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			await emit(eventSink, {
				type: "run.retrying",
				runId: request.runId,
				message: `Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts}): ${retryEvent.errorMessage}`,
			});
		}
	});

	const imageAttachments: ImageContent[] = [];
	const nonImagePaths: string[] = [];
	const materializedAttachments: Array<{ cleanup?: () => Promise<void> }> = [];

	for (const attachment of request.attachments || []) {
		const materialized = await blobStore.materialize(attachment);
		materializedAttachments.push({ cleanup: materialized.cleanup });
		const mimeType = attachment.mimeType || getImageMimeType(materialized.path);
		if (mimeType && existsSync(materialized.path)) {
			try {
				imageAttachments.push({
					type: "image",
					mimeType,
					data: readFileSync(materialized.path).toString("base64"),
				});
			} catch {
				nonImagePaths.push(materialized.path);
			}
		} else {
			nonImagePaths.push(materialized.path);
		}
	}

	const userMessage = formatUserMessage(request, nonImagePaths);
	await appendJsonlLine(requestLogPath, {
		type: "run.requested",
		runId: request.runId,
		sessionId: request.sessionId,
		userMessage,
		timestamp: Date.now(),
	});

	await emit(eventSink, {
		type: "run.started",
		runId: request.runId,
		sessionId: request.sessionId,
		workspaceDir: workingDir,
	});

	log.logInfo(logCtx, `Using model ${model.provider}/${model.id}`);
	if (syncedCount > 0) {
		await emit(eventSink, {
			type: "run.progress",
			runId: request.runId,
			message: `Synced ${syncedCount} messages from session log`,
		});
	}

	try {
		if (abortSignal?.aborted) {
			session.abort();
			throw new Error("Run aborted before prompt execution");
		}

		if (abortSignal) {
			abortSignal.addEventListener("abort", () => session.abort(), { once: true });
		}

		await writeFile(
			join(sessionDir, "last_prompt.json"),
			JSON.stringify(
				{
					systemPrompt,
					messages: session.messages,
					newUserMessage: userMessage,
					imageAttachmentCount: imageAttachments.length,
				},
				null,
				2,
			),
			"utf-8",
		);

		await session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

		const messages = session.messages;
		const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
		const finalText =
			lastAssistant?.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n") || "";

		const usage = buildUsageSummary(messages, model);
		await appendJsonlLine(requestLogPath, {
			type: "run.completed",
			runId: request.runId,
			stopReason,
			errorMessage,
			finalText,
			usage,
			timestamp: Date.now(),
		});

		if (stopReason === "error" && errorMessage) {
			await emit(eventSink, { type: "run.failed", runId: request.runId, error: errorMessage });
			return;
		}

		if (finalText.trim()) {
			await emit(eventSink, { type: "assistant.message", runId: request.runId, text: finalText });
		}

		await flushPendingArtifacts();

		await emit(eventSink, {
			type: "run.completed",
			runId: request.runId,
			stopReason,
			finalText,
			usage,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.logError(logCtx, "Worker run failed", message);
		await appendJsonlLine(requestLogPath, {
			type: "run.failed",
			runId: request.runId,
			error: message,
			timestamp: Date.now(),
		});
		await emit(eventSink, { type: "run.failed", runId: request.runId, error: message });
	} finally {
		for (const attachment of materializedAttachments) {
			await attachment.cleanup?.();
		}
	}
}
