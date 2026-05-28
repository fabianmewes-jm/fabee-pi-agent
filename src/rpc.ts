import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { assertValidEnvelope, type Envelope, type Item, type ProtocolCapabilities } from "@jobmatchme/bee-dance-core";
import { BEE_PROTOCOL_VERSION_MANIFEST } from "@jobmatchme/bee-dance-schema";
import { loadWorkerRuntimeConfigFromEnv } from "./config.js";
import * as log from "./log.js";
import type {
	InternalWorkerRunRequest,
	WorkerActorInput,
	WorkerArtifactRef,
	WorkerRunEvent,
	WorkerRuntimeConfig,
} from "./types.js";
import { runWorker } from "./worker.js";

const DEFAULT_CAPABILITIES: ProtocolCapabilities = {
	coreVersions: [BEE_PROTOCOL_VERSION_MANIFEST.protocolVersion],
	inputParts: ["text"],
	outputParts: ["text", "status", "artifactRef"],
	events: ["run.started", "run.completed", "run.failed", "item.appended", "item.updated"],
	actions: [],
	extensions: {},
	streaming: true,
};

interface ActiveTurnState {
	runId: string;
	sessionId: string;
	threadId?: string;
	turnId: string;
	controller: AbortController;
	updatedAt: string;
	cancelRequested: boolean;
	assistantItemId?: string;
}

export interface WorkerBeeServer {
	close(): void;
	completed: Promise<void>;
}

export function createWorkerBeePeer(
	input: Readable,
	output: Writable,
	runtimeConfig: WorkerRuntimeConfig = loadWorkerRuntimeConfigFromEnv(),
): WorkerBeeServer {
	const activeRunsBySession = new Map<string, ActiveTurnState>();
	const activeRunsByTurnId = new Map<string, ActiveTurnState>();

	let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let draining = false;
	let closed = false;

	const completed = new Promise<void>((resolveCompleted) => {
		const drain = async (): Promise<void> => {
			if (draining || closed) return;
			draining = true;

			try {
				while (true) {
					const next = readFramedMessage(buffer);
					if (!next) break;
					buffer = next.rest;
					await handleRawMessage(next.payload);
				}
			} finally {
				draining = false;
			}
		};

		const onData = (chunk: Buffer | string) => {
			const nextChunk = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : Buffer.from(chunk);
			buffer = Buffer.concat([buffer, nextChunk]);
			void drain();
		};

		const onEnd = () => {
			closed = true;
			resolveCompleted();
		};

		const onError = (error: unknown) => {
			log.logError("system", "Bee socket input stream failed", String(error));
			closed = true;
			resolveCompleted();
		};

		input.on("data", onData);
		input.on("end", onEnd);
		input.on("close", onEnd);
		input.on("error", onError);
	});

	return {
		close() {
			if (closed) return;
			closed = true;
			for (const activeRun of activeRunsByTurnId.values()) {
				activeRun.controller.abort();
			}
			input.removeAllListeners("data");
			input.removeAllListeners("end");
			input.removeAllListeners("close");
			input.removeAllListeners("error");
		},
		completed,
	};

	async function handleRawMessage(payload: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch (error) {
			log.logError("system", "Failed to parse Bee envelope", String(error));
			return;
		}

		let envelope: Envelope;
		try {
			assertValidEnvelope(parsed);
			envelope = parsed as Envelope;
		} catch (error) {
			log.logError("system", "Invalid Bee envelope", String(error));
			return;
		}

		try {
			if (envelope.name === "protocol.hello") {
				writeEnvelope(output, createProtocolWelcome(envelope));
				return;
			}
			if (envelope.name === "turn.start") {
				handleTurnStart(envelope);
				return;
			}
			if (envelope.name === "turn.cancel") {
				handleTurnCancel(envelope);
				return;
			}
			log.logWarning("system", `Unsupported Bee envelope name: ${envelope.name}`);
		} catch (error) {
			log.logError("system", `Failed to handle Bee envelope ${envelope.name}`, String(error));
		}
	}

	function handleTurnStart(envelope: Envelope): void {
		if (!envelope.sessionId) {
			throw new Error("turn.start missing sessionId");
		}
		if (activeRunsBySession.has(envelope.sessionId)) {
			throw new Error(`Session already has an active turn: ${envelope.sessionId}`);
		}

		const runId = envelope.turnId || randomUUID();
		const request = toWorkerRunRequest(envelope, runId);
		const activeRun: ActiveTurnState = {
			runId,
			sessionId: request.sessionId,
			threadId: request.threadId,
			turnId: request.turnId || runId,
			controller: new AbortController(),
			updatedAt: new Date().toISOString(),
			cancelRequested: false,
		};

		activeRunsBySession.set(request.sessionId, activeRun);
		activeRunsByTurnId.set(activeRun.turnId, activeRun);
		void runInBackground(request, activeRun, envelope.from);
	}

	function handleTurnCancel(envelope: Envelope): void {
		const turnId = envelope.turnId;
		if (!turnId) return;
		const active = activeRunsByTurnId.get(turnId);
		if (!active) return;
		active.cancelRequested = true;
		active.updatedAt = new Date().toISOString();
		active.controller.abort();
	}

	async function runInBackground(
		request: InternalWorkerRunRequest,
		activeRun: ActiveTurnState,
		requester: Envelope["from"],
	): Promise<void> {
		try {
			await runWorker(
				request,
				runtimeConfig,
				async (event) => {
					for (const envelope of mapEventToBeeEnvelopes(event, activeRun, requester, runtimeConfig)) {
						writeEnvelope(output, envelope);
					}
				},
				activeRun.controller.signal,
			);
		} catch (error) {
			const message = activeRun.cancelRequested
				? "Turn cancelled by client"
				: error instanceof Error
					? error.message
					: String(error);
			writeEnvelope(
				output,
				createRunEventEnvelope(activeRun, requester, "run.failed", { eventType: "run.failed", error: message }),
			);
		} finally {
			activeRunsBySession.delete(request.sessionId);
			activeRunsByTurnId.delete(activeRun.turnId);
		}
	}
}

export async function createWorkerBeeSocketServer(
	socketPath: string,
	runtimeConfig: WorkerRuntimeConfig = loadWorkerRuntimeConfigFromEnv(),
): Promise<WorkerBeeServer> {
	await rm(socketPath, { force: true });

	const peers = new Set<WorkerBeeServer>();
	let serverClosed = false;
	let resolveCompleted!: () => void;
	const completed = new Promise<void>((resolve) => {
		resolveCompleted = resolve;
	});

	const server = createServer((socket: Socket) => {
		const peer = createWorkerBeePeer(socket, socket, runtimeConfig);
		peers.add(peer);
		void peer.completed.finally(() => {
			peers.delete(peer);
			if (serverClosed && peers.size === 0) {
				resolveCompleted();
			}
		});
	});

	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(socketPath, () => {
			server.off("error", rejectPromise);
			resolvePromise();
		});
	});

	log.logInfo("system", `bee-pi-agent listening on unix socket ${socketPath}`);

	return {
		close() {
			if (serverClosed) return;
			serverClosed = true;
			for (const peer of peers) {
				peer.close();
			}
			server.close(() => {
				void rm(socketPath, { force: true }).finally(() => {
					if (peers.size === 0) {
						resolveCompleted();
					}
				});
			});
		},
		completed,
	};
}

function createProtocolWelcome(envelope: Envelope): Envelope {
	return {
		id: `msg_${randomUUID()}`,
		type: "response",
		name: "protocol.welcome",
		time: new Date().toISOString(),
		sessionId: envelope.sessionId,
		threadId: envelope.threadId,
		turnId: envelope.turnId,
		from: { kind: "agent", id: "agent:bee-pi-agent" },
		to: envelope.from,
		replyTo: envelope.id,
		payload: {
			protocolVersion: BEE_PROTOCOL_VERSION_MANIFEST.protocolVersion,
			selectedCoreVersion: BEE_PROTOCOL_VERSION_MANIFEST.protocolVersion,
			capabilities: DEFAULT_CAPABILITIES,
		},
	};
}

function toWorkerRunRequest(envelope: Envelope, runId: string): InternalWorkerRunRequest {
	const payload = (envelope.payload || {}) as {
		input?: Array<{ kind?: string; text?: string }>;
		hints?: Record<string, unknown>;
	};
	const firstText = payload.input?.find((part) => part.kind === "text" && typeof part.text === "string")?.text;
	if (!firstText) {
		throw new Error("turn.start payload must contain a text input part");
	}

	const hints = payload.hints || {};
	const actorHint = isWorkerActorInput(hints.actor) ? hints.actor : undefined;
	const attachments = Array.isArray(hints.attachments)
		? (hints.attachments as InternalWorkerRunRequest["attachments"])
		: undefined;
	const conversationId = typeof hints.conversationId === "string" ? hints.conversationId : envelope.sessionId;
	const transport = typeof hints.transport === "string" ? hints.transport : undefined;
	const actor: WorkerActorInput = actorHint || {
		userId: envelope.from.id,
		userName: envelope.from.id,
	};

	return {
		runId,
		sessionId: envelope.sessionId,
		threadId: envelope.threadId,
		turnId: envelope.turnId || runId,
		conversation: {
			conversationId,
			transport,
		},
		actor,
		message: {
			text: firstText,
		},
		attachments,
	};
}

function mapEventToBeeEnvelopes(
	event: WorkerRunEvent,
	activeRun: ActiveTurnState,
	requester: Envelope["from"],
	runtimeConfig: WorkerRuntimeConfig,
): Envelope[] {
	switch (event.type) {
		case "run.started":
			return [
				createRunEventEnvelope(activeRun, requester, "run.started", {
					eventType: "run.started",
					workspaceDir: event.workspaceDir,
				}),
			];
		case "run.completed":
			return [
				createRunEventEnvelope(activeRun, requester, "run.completed", {
					eventType: "run.completed",
					stopReason: event.stopReason,
				}),
			];
		case "run.failed":
			return [
				createRunEventEnvelope(activeRun, requester, "run.failed", {
					eventType: "run.failed",
					error: event.error,
				}),
			];
		case "assistant.message": {
			if (!activeRun.assistantItemId) {
				activeRun.assistantItemId = `item_${randomUUID()}`;
				return [
					createItemEventEnvelope(activeRun, requester, "item.appended", {
						eventType: "item.appended",
						item: createTextItem(activeRun.assistantItemId, "message", event.text),
					}),
				];
			}
			return [
				createItemEventEnvelope(activeRun, requester, "item.updated", {
					eventType: "item.updated",
					itemId: activeRun.assistantItemId,
					appendParts: [{ kind: "text", text: event.text }],
				}),
			];
		}
		case "assistant.thinking":
			return [];
		case "artifact.created":
			return [
				createItemEventEnvelope(activeRun, requester, "item.appended", {
					eventType: "item.appended",
					item: {
						id: `item_${randomUUID()}`,
						kind: "artifact",
						role: "assistant",
						parts: [createArtifactRefPart(event.artifact, runtimeConfig)],
					},
				}),
			];
		default:
			return [];
	}
}

function createArtifactRefPart(
	artifact: WorkerArtifactRef,
	runtimeConfig: WorkerRuntimeConfig,
): Extract<Item["parts"][number], { kind: "artifactRef" }> {
	const part: Extract<Item["parts"][number], { kind: "artifactRef" }> = {
		kind: "artifactRef",
		artifactId: artifact.artifactId,
	};
	if (artifact.name) part.name = artifact.name;
	if (artifact.title) part.title = artifact.title;
	if (artifact.mimeType) part.mimeType = artifact.mimeType;
	const uri = buildArtifactDataUri(artifact, runtimeConfig);
	if (uri) part.uri = uri;
	if (artifact.sizeBytes !== undefined) part.sizeBytes = artifact.sizeBytes;
	return part;
}

function getArtifactInlineMaxBytes(): number {
	const raw = process.env.BEE_PI_AGENT_ARTIFACT_INLINE_MAX_BYTES;
	if (!raw) return 750_000;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 750_000;
}

function buildArtifactDataUri(artifact: WorkerArtifactRef, runtimeConfig: WorkerRuntimeConfig): string | undefined {
	if (!artifact.blobKey) return undefined;
	const artifactPath = join(runtimeConfig.blobStore.rootDir, artifact.blobKey);
	if (!existsSync(artifactPath)) return undefined;

	try {
		const maxBytes = getArtifactInlineMaxBytes();
		const details = statSync(artifactPath);
		if (details.size > maxBytes) {
			log.logWarning(
				"system",
				`Artifact ${artifact.name || artifact.artifactId} is ${details.size} bytes; omitting inline URI because limit is ${maxBytes} bytes`,
			);
			return undefined;
		}

		const mimeType = artifact.mimeType || "application/octet-stream";
		const data = readFileSync(artifactPath).toString("base64");
		return `data:${mimeType};base64,${data}`;
	} catch (error) {
		log.logWarning(
			"system",
			`Failed to inline artifact ${artifact.name || artifact.artifactId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

function createTextItem(itemId: string, kind: "message" | "thinking", text: string): Item {
	return {
		id: itemId,
		kind,
		role: "assistant",
		parts: [{ kind: "text", text }],
	};
}

function createRunEventEnvelope(
	activeRun: ActiveTurnState,
	requester: Envelope["from"],
	name: string,
	payload: unknown,
): Envelope {
	return {
		id: `msg_${randomUUID()}`,
		type: "event",
		name,
		time: new Date().toISOString(),
		sessionId: activeRun.sessionId,
		threadId: activeRun.threadId,
		turnId: activeRun.turnId,
		from: { kind: "agent", id: "agent:bee-pi-agent" },
		to: requester,
		replyTo: null,
		payload,
	};
}

function createItemEventEnvelope(
	activeRun: ActiveTurnState,
	requester: Envelope["from"],
	name: string,
	payload: unknown,
): Envelope {
	return createRunEventEnvelope(activeRun, requester, name, payload);
}

function writeEnvelope(output: Writable, envelope: Envelope): void {
	assertValidEnvelope(envelope);
	const json = JSON.stringify(envelope);
	const frame = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
	output.write(frame);
}

function readFramedMessage(
	buffer: Buffer<ArrayBufferLike>,
): { payload: string; rest: Buffer<ArrayBufferLike> } | undefined {
	const headerEnd = buffer.indexOf("\r\n\r\n");
	if (headerEnd === -1) return undefined;

	const header = buffer.slice(0, headerEnd).toString("utf-8");
	const contentLength = parseContentLength(header);
	if (contentLength === undefined) {
		throw new Error("Missing Content-Length header");
	}

	const bodyStart = headerEnd + 4;
	const bodyEnd = bodyStart + contentLength;
	if (buffer.length < bodyEnd) return undefined;

	return {
		payload: buffer.slice(bodyStart, bodyEnd).toString("utf-8"),
		rest: buffer.slice(bodyEnd),
	};
}

function parseContentLength(header: string): number | undefined {
	for (const line of header.split("\r\n")) {
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1) continue;
		const key = line.slice(0, separatorIndex).trim().toLowerCase();
		if (key !== "content-length") continue;
		const value = Number.parseInt(line.slice(separatorIndex + 1).trim(), 10);
		return Number.isFinite(value) ? value : undefined;
	}
	return undefined;
}

function isWorkerActorInput(value: unknown): value is WorkerActorInput {
	return (
		typeof value === "object" &&
		value !== null &&
		"userId" in value &&
		typeof (value as { userId?: unknown }).userId === "string"
	);
}
