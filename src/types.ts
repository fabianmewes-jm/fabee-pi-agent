export interface WorkerWorkspaceConfig {
	rootDir: string;
	cwd?: string;
	stateDir?: string;
	memoryFile?: string;
	skillsDir?: string;
}

export interface WorkerModelConfig {
	provider?: string;
	modelId?: string;
}

export interface WorkerSandboxConfig {
	type: "host" | "docker";
	container?: string;
	workspaceRoot?: string;
}

export interface WorkerRuntimeConfig {
	workspace: WorkerWorkspaceConfig;
	model?: WorkerModelConfig;
	sandbox?: WorkerSandboxConfig;
	systemPromptAppend?: string;
	blobStore: {
		rootDir: string;
	};
}

export interface WorkerActorInput {
	userId: string;
	userName?: string;
	displayName?: string;
	email?: string;
}

export interface WorkerConversationInput {
	conversationId: string;
	transport?: string;
}

export interface WorkerMessageInput {
	text: string;
}

export interface WorkerAttachmentInput {
	attachmentId: string;
	blobKey: string;
	name?: string;
	title?: string;
	mimeType?: string;
	sizeBytes?: number;
}

export interface WorkerArtifactRef {
	artifactId: string;
	blobKey: string;
	name?: string;
	title?: string;
	mimeType?: string;
	sizeBytes?: number;
}

export interface WorkerRunRequest {
	sessionId: string;
	threadId?: string;
	turnId?: string;
	conversation: WorkerConversationInput;
	actor: WorkerActorInput;
	message: WorkerMessageInput;
	attachments?: WorkerAttachmentInput[];
}

export interface InternalWorkerRunRequest extends WorkerRunRequest {
	runId: string;
}

export interface WorkerSessionTranscriptEntry {
	role: "user" | "assistant" | "system" | "tool";
	text: string;
	timestamp?: string;
	toolName?: string;
	isError?: boolean;
}

export interface WorkerUsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	contextTokens?: number;
	contextWindow?: number;
}

export type WorkerRunEvent =
	| { type: "run.started"; runId: string; sessionId: string; workspaceDir?: string }
	| { type: "run.progress"; runId: string; message: string }
	| {
			type: "tool.started";
			runId: string;
			toolName: string;
			label?: string;
			args?: Record<string, unknown>;
	  }
	| {
			type: "tool.completed";
			runId: string;
			toolName: string;
			success: boolean;
			durationMs?: number;
			result?: string;
			label?: string;
			args?: Record<string, unknown>;
	  }
	| { type: "assistant.thinking"; runId: string; text: string }
	| { type: "assistant.message"; runId: string; text: string }
	| { type: "artifact.created"; runId: string; artifact: WorkerArtifactRef }
	| { type: "run.compaction"; runId: string; message: string }
	| { type: "run.retrying"; runId: string; message: string }
	| {
			type: "run.completed";
			runId: string;
			stopReason?: string;
			finalText?: string;
			usage?: WorkerUsageSummary;
	  }
	| { type: "run.failed"; runId: string; error: string };

export type WorkerEventSink = (event: WorkerRunEvent) => Promise<void> | void;
