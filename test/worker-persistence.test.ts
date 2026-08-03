import { describe, expect, it } from "vitest";
import type { InternalWorkerRunRequest, WorkerArtifactRef } from "../src/types.js";
import {
	createArtifactCreatedLogEntry,
	createArtifactReferenceEntry,
	createArtifactRegisteredEntry,
	createRunRequestedLogEntry,
} from "../src/worker.js";

describe("worker persistence log entries", () => {
	it("keeps the raw prompt and structured actor email on run.requested", () => {
		const request: InternalWorkerRunRequest = {
			runId: "run-1",
			sessionId: "session-1",
			conversation: { conversationId: "conversation-1" },
			actor: {
				userId: "U123",
				userName: "fabian",
				displayName: "Fabian Mewes",
				email: "fabian@example.com",
			},
			message: { text: "unchanged prompt" },
		};

		expect(createRunRequestedLogEntry(request, "formatted prompt", 123)).toEqual({
			type: "run.requested",
			runId: "run-1",
			sessionId: "session-1",
			actor: {
				userId: "U123",
				userName: "fabian",
				displayName: "Fabian Mewes",
				email: "fabian@example.com",
			},
			prompt: "unchanged prompt",
			userMessage: "formatted prompt",
			timestamp: 123,
		});
	});

	it("stores artifact metadata only", () => {
		const artifact: WorkerArtifactRef = {
			artifactId: "artifact-1",
			blobKey: "artifacts/session/run/chart.png",
			name: "chart.png",
			title: "Chart",
			mimeType: "image/png",
			sizeBytes: 42,
		};

		expect(createArtifactCreatedLogEntry("run-1", "ses_1", artifact, 456)).toEqual({
			type: "artifact.created",
			runId: "run-1",
			sessionId: "ses_1",
			...artifact,
			timestamp: 456,
		});
	});

	it("creates append-only artifact registry and reference entries", () => {
		const artifact: WorkerArtifactRef = {
			artifactId: "artifact-1",
			blobKey: "artifacts/session/run/chart.png",
			name: "chart.png",
			mimeType: "image/png",
			sizeBytes: 42,
		};

		expect(createArtifactRegisteredEntry("session-1", artifact, "turn-1", "2026-08-03T12:00:00.000Z")).toEqual({
			type: "artifact.registered",
			artifactId: "artifact-1",
			sessionId: "session-1",
			blobKey: "artifacts/session/run/chart.png",
			name: "chart.png",
			mimeType: "image/png",
			sizeBytes: 42,
			createdAt: "2026-08-03T12:00:00.000Z",
			createdByTurnId: "turn-1",
		});

		expect(
			createArtifactReferenceEntry({
				referenceId: "ref-1",
				artifactId: "artifact-1",
				turnId: "turn-1",
				messageId: "msg-1",
				createdAt: "2026-08-03T12:01:00.000Z",
			}),
		).toEqual({
			type: "artifactRef",
			referenceId: "ref-1",
			artifactId: "artifact-1",
			turnId: "turn-1",
			messageId: "msg-1",
			timestamp: "2026-08-03T12:01:00.000Z",
		});
	});
});
