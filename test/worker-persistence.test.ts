import { describe, expect, it } from "vitest";
import type { InternalWorkerRunRequest, WorkerArtifactRef } from "../src/types.js";
import { createArtifactCreatedLogEntry, createRunRequestedLogEntry } from "../src/worker.js";

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
});
