/**
 * Adapted from vendor/pi-mono/packages/mom/src/context.ts.
 *
 * Changes:
 * - session storage is generic to worker session directories
 * - synced log input is optional and generic, not Slack-specific
 */

import type { UserMessage } from "@earendil-works/pi-ai";
import { SessionManager, type SessionMessageEntry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { WorkerSessionTranscriptEntry } from "./types.js";

export interface LoggedUserMessage {
	timestamp?: number;
	date?: string;
	userName?: string;
	text?: string;
}

export function syncLogToSessionManager(
	sessionManager: SessionManager,
	sessionDir: string,
	excludeTimestamp?: number,
): number {
	const logFile = join(sessionDir, "log.jsonl");

	if (!existsSync(logFile)) return 0;

	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const msgEntry = entry as SessionMessageEntry;
		const msg = msgEntry.message as { role: string; content?: unknown };
		if (msg.role !== "user" || msg.content === undefined) continue;

		if (typeof msg.content === "string") {
			existingMessages.add(msg.content);
			continue;
		}

		if (!Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
				existingMessages.add((part as { text: string }).text);
			}
		}
	}

	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);
	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg = JSON.parse(line) as LoggedUserMessage;
			const timestamp = logMsg.timestamp ?? (logMsg.date ? new Date(logMsg.date).getTime() : undefined);
			if (!timestamp || (excludeTimestamp && timestamp === excludeTimestamp)) continue;

			const text = logMsg.text?.trim();
			if (!text || existingMessages.has(text)) continue;

			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text }],
				timestamp,
			};
			newMessages.push({ timestamp, message: userMessage });
			existingMessages.add(text);
		} catch {
			// skip malformed lines
		}
	}

	if (newMessages.length === 0) return 0;

	newMessages.sort((a, b) => a.timestamp - b.timestamp);
	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

type WorkerSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

class WorkspaceSettingsStorage implements WorkerSettingsStorage {
	private settingsPath: string;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
	}

	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		if (scope === "project") {
			fn(undefined);
			return;
		}

		const current = existsSync(this.settingsPath) ? readFileSync(this.settingsPath, "utf-8") : undefined;
		const next = fn(current);
		if (next === undefined) return;

		const dir = dirname(this.settingsPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.settingsPath, next, "utf-8");
	}
}

export function createWorkerSettingsManager(workspaceDir: string): SettingsManager {
	return SettingsManager.fromStorage(new WorkspaceSettingsStorage(workspaceDir));
}

export function readWorkerSessionTranscript(
	contextFile: string,
	workingDir: string,
	limit?: number,
): {
	transcript: WorkerSessionTranscriptEntry[];
	messageCount: number;
	updatedAt?: string;
	transcriptTruncated: boolean;
} {
	if (!existsSync(contextFile)) {
		return { transcript: [], messageCount: 0, transcriptTruncated: false };
	}

	const sessionManager = SessionManager.open(contextFile, workingDir);
	const transcript = sessionManager
		.buildSessionContext()
		.messages.map(mapAgentMessageToTranscriptEntry)
		.filter((entry): entry is WorkerSessionTranscriptEntry => entry !== undefined);
	const messageCount = transcript.length;
	const transcriptTruncated = limit !== undefined && limit >= 0 && transcript.length > limit;
	const trimmedTranscript = transcriptTruncated ? transcript.slice(-limit) : transcript;
	const updatedAt = statSync(contextFile).mtime.toISOString();

	return {
		transcript: trimmedTranscript,
		messageCount,
		updatedAt,
		transcriptTruncated,
	};
}

function mapAgentMessageToTranscriptEntry(message: any): WorkerSessionTranscriptEntry | undefined {
	const text = extractMessageText(message.content);
	if (!text) return undefined;

	if (message.role === "user" || message.role === "assistant" || message.role === "system") {
		return {
			role: message.role,
			text,
			timestamp: typeof message.timestamp === "string" ? message.timestamp : undefined,
		};
	}

	if (message.role === "toolResult") {
		return {
			role: "tool",
			text,
			timestamp: typeof message.timestamp === "string" ? message.timestamp : undefined,
			toolName: typeof message.toolName === "string" ? message.toolName : undefined,
			isError: typeof message.isError === "boolean" ? message.isError : undefined,
		};
	}

	return {
		role: "system",
		text,
		timestamp: typeof message.timestamp === "string" ? message.timestamp : undefined,
	};
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}

	if (!Array.isArray(content)) {
		return "";
	}

	const text = content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null || !("type" in part)) return [];
			if (part.type === "text" && "text" in part && typeof part.text === "string") return [part.text];
			if (part.type === "thinking" && "thinking" in part && typeof part.thinking === "string")
				return [part.thinking];
			return [];
		})
		.join("\n")
		.trim();

	return text;
}
