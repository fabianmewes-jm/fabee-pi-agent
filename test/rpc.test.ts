import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerLocalBlobStore } from "../src/blob-store.js";

const { runWorkerMock } = vi.hoisted(() => ({
	runWorkerMock: vi.fn(),
}));

vi.mock("../src/worker.js", () => ({
	runWorker: runWorkerMock,
}));

import { createWorkerBeePeer } from "../src/rpc.js";
import type { InternalWorkerRunRequest, WorkerRuntimeConfig } from "../src/types.js";

type OutboundMessage = Record<string, unknown>;

function frame(payload: unknown): Buffer {
	const json = JSON.stringify(payload);
	return Buffer.from(`Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`, "utf-8");
}

function createOutputCollector(stream: PassThrough): OutboundMessage[] {
	const messages: OutboundMessage[] = [];
	let buffer = Buffer.alloc(0);

	stream.on("data", (chunk: Buffer | string) => {
		buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

		while (true) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;
			const header = buffer.slice(0, headerEnd).toString("utf-8");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) throw new Error("Missing Content-Length");
			const contentLength = Number.parseInt(match[1], 10);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + contentLength;
			if (buffer.length < bodyEnd) break;

			messages.push(JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf-8")) as OutboundMessage);
			buffer = buffer.slice(bodyEnd);
		}
	});

	return messages;
}

async function startBeeServer(runtimeConfigOverride?: WorkerRuntimeConfig) {
	const rootDir = mkdtempSync(join(tmpdir(), "bee-pi-agent-rpc-"));
	const runtimeConfig: WorkerRuntimeConfig = {
		workspace: {
			rootDir,
		},
		blobStore: {
			rootDir: join(rootDir, "blob-store"),
		},
		sandbox: {
			type: "host",
		},
		...runtimeConfigOverride,
	};

	const input = new PassThrough();
	const output = new PassThrough();
	const messages = createOutputCollector(output);
	const server = createWorkerBeePeer(input, output, runtimeConfig);

	return {
		input,
		output,
		messages,
		runtimeConfig,
		close: async () => {
			server.close();
			input.destroy();
			output.destroy();
		},
	};
}

afterEach(() => {
	runWorkerMock.mockReset();
});

describe("createWorkerBeePeer", () => {
	it("responds to protocol.hello with protocol.welcome", async () => {
		const server = await startBeeServer();

		try {
			server.input.write(
				frame({
					id: "msg-1",
					type: "command",
					name: "protocol.hello",
					time: new Date().toISOString(),
					sessionId: "session-123",
					turnId: "turn-123",
					from: { kind: "human", id: "U123" },
					to: { kind: "agent", id: "agent:bee-pi-agent" },
					replyTo: null,
					payload: {
						protocolVersion: "2026-04-02",
						capabilities: {
							coreVersions: ["2026-04-02"],
							inputParts: ["text"],
							outputParts: ["text"],
							events: ["run.started"],
							actions: [],
							extensions: {},
							streaming: true,
						},
					},
				}),
			);

			await vi.waitFor(() => {
				expect(server.messages.length).toBe(1);
			});

			expect(server.messages[0]).toMatchObject({
				type: "response",
				name: "protocol.welcome",
				replyTo: "msg-1",
				sessionId: "session-123",
				turnId: "turn-123",
				payload: {
					capabilities: {
						events: ["run.started", "run.completed", "run.failed", "item.appended", "item.updated"],
					},
				},
			});
		} finally {
			await server.close();
		}
	});

	it("streams Bee Dance event envelopes for a started turn", async () => {
		runWorkerMock.mockImplementation(
			async (request: InternalWorkerRunRequest, _runtimeConfig: WorkerRuntimeConfig, sink) => {
				await sink({
					type: "run.started",
					runId: request.runId,
					sessionId: request.sessionId,
					workspaceDir: "/tmp/workspace",
				});
				await sink({
					type: "assistant.thinking",
					runId: request.runId,
					text: "internal reasoning must not be forwarded",
				});
				await sink({
					type: "assistant.message",
					runId: request.runId,
					text: "done",
				});
				await sink({
					type: "assistant.message",
					runId: request.runId,
					text: " plus update",
				});
				await sink({
					type: "run.completed",
					runId: request.runId,
					stopReason: "completed",
					finalText: "done plus update",
					messageId: "persisted-msg-123",
				});
			},
		);

		const server = await startBeeServer();

		try {
			server.input.write(
				frame({
					id: "msg-10",
					type: "command",
					name: "turn.start",
					time: new Date().toISOString(),
					sessionId: "session-123",
					turnId: "turn-123",
					from: { kind: "human", id: "U123" },
					to: { kind: "agent", id: "agent:bee-pi-agent" },
					replyTo: null,
					payload: {
						input: [{ kind: "text", text: "Inspect the worker." }],
						hints: {
							conversationId: "slack:T123:C123:1711111111_000100",
							actor: { userId: "U123", userName: "gunnar", email: "gunnar@example.com" },
						},
					},
				}),
			);

			await vi.waitFor(() => {
				expect(server.messages.length).toBe(4);
			});

			expect(runWorkerMock).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: "turn-123",
					sessionId: "session-123",
					turnId: "turn-123",
					conversation: expect.objectContaining({
						conversationId: "slack:T123:C123:1711111111_000100",
					}),
					actor: expect.objectContaining({ userId: "U123", userName: "gunnar", email: "gunnar@example.com" }),
					message: { text: "Inspect the worker." },
				}),
				expect.objectContaining({ workspace: expect.objectContaining({ rootDir: expect.any(String) }) }),
				expect.any(Function),
				expect.any(AbortSignal),
			);

			expect(server.messages).toEqual([
				expect.objectContaining({
					type: "event",
					name: "run.started",
					turnId: "turn-123",
					payload: { eventType: "run.started", workspaceDir: "/tmp/workspace" },
				}),
				expect.objectContaining({
					type: "event",
					name: "item.appended",
					turnId: "turn-123",
					payload: expect.objectContaining({
						eventType: "item.appended",
						item: expect.objectContaining({
							kind: "message",
							parts: [{ kind: "text", text: "done" }],
						}),
					}),
				}),
				expect.objectContaining({
					type: "event",
					name: "item.updated",
					turnId: "turn-123",
					payload: expect.objectContaining({
						eventType: "item.updated",
						itemId: expect.any(String),
						appendParts: [{ kind: "text", text: " plus update" }],
					}),
				}),
				expect.objectContaining({
					type: "event",
					name: "run.completed",
					turnId: "turn-123",
					payload: { eventType: "run.completed", stopReason: "completed" },
				}),
			]);
		} finally {
			await server.close();
		}
	});

	it("emits transport-neutral action items for every correlated tool call", async () => {
		runWorkerMock.mockImplementation(async (request: InternalWorkerRunRequest, _runtimeConfig, sink) => {
			await sink({
				type: "tool.started",
				runId: request.runId,
				toolCallId: "call-1",
				toolName: "read",
				title: "Datei lesen",
				label: "Konfiguration prüfen",
				args: { label: "Konfiguration prüfen", path: "/secret/path" },
			});
			await sink({
				type: "tool.completed",
				runId: request.runId,
				toolCallId: "call-1",
				toolName: "read",
				title: "Datei lesen",
				label: "Konfiguration prüfen",
				success: true,
				result: "raw result must not be transported",
			});
			await sink({
				type: "tool.started",
				runId: request.runId,
				toolCallId: "call-2",
				toolName: "read",
				title: "Datei lesen",
				label: "Fehlende Datei lesen",
			});
			await sink({
				type: "tool.completed",
				runId: request.runId,
				toolCallId: "call-2",
				toolName: "read",
				title: "Datei lesen",
				success: false,
				result: "raw error must not be transported",
			});
		});

		const server = await startBeeServer();
		try {
			server.input.write(
				frame({
					id: "msg-actions",
					type: "command",
					name: "turn.start",
					time: new Date().toISOString(),
					sessionId: "session-actions",
					turnId: "turn-actions",
					from: { kind: "human", id: "U123" },
					to: { kind: "agent", id: "agent:bee-pi-agent" },
					replyTo: null,
					payload: {
						input: [{ kind: "text", text: "Read two files." }],
						hints: { transport: "slack" },
					},
				}),
			);

			await vi.waitFor(() => expect(server.messages).toHaveLength(4));
			expect(server.messages.map(({ name }) => name)).toEqual([
				"item.appended",
				"item.updated",
				"item.appended",
				"item.updated",
			]);
			expect(server.messages[0]).toMatchObject({
				payload: {
					eventType: "item.appended",
					item: {
						id: "call-1",
						kind: "action",
						role: "tool",
						parts: [
							{ kind: "text", text: "Datei lesen" },
							{ kind: "text", text: "Konfiguration prüfen" },
							{ kind: "status", status: "in_progress" },
						],
					},
				},
			});
			expect(server.messages[1]).toMatchObject({
				payload: {
					eventType: "item.updated",
					itemId: "call-1",
					appendParts: [{ kind: "status", status: "complete" }],
				},
			});
			expect(server.messages[2]).toMatchObject({
				payload: {
					item: { id: "call-2", parts: expect.arrayContaining([{ kind: "status", status: "in_progress" }]) },
				},
			});
			expect(server.messages[3]).toMatchObject({
				payload: { itemId: "call-2", appendParts: [{ kind: "status", status: "error" }] },
			});
			expect(JSON.stringify(server.messages)).not.toContain("raw result");
			expect(JSON.stringify(server.messages)).not.toContain("raw error");
			expect(JSON.stringify(server.messages)).not.toContain("/secret/path");
		} finally {
			await server.close();
		}
	});

	it("embeds PNG artifacts as data URI artifact refs via blob store plumbing", async () => {
		runWorkerMock.mockImplementation(
			async (request: InternalWorkerRunRequest, runtimeConfig: WorkerRuntimeConfig, sink) => {
				const blobStore = new WorkerLocalBlobStore(runtimeConfig.blobStore.rootDir);
				const artifact = await blobStore.putArtifact({
					namespace: `artifacts/${request.sessionId}/${request.runId}`,
					data: Buffer.from("89504e470d0a1a0a", "hex"),
					name: "likes.png",
					title: "likes.png",
					mimeType: "image/png",
				});
				await sink({
					type: "assistant.message",
					runId: request.runId,
					text: "Here is the chart.",
					messageId: "persisted-assistant-message",
				});
				await sink({
					type: "artifact.created",
					runId: request.runId,
					artifact,
					reference: {
						referenceId: "ref-artifact",
						artifactId: artifact.artifactId,
						turnId: request.turnId || request.runId,
						messageId: "persisted-assistant-message",
						createdAt: "2026-08-03T12:02:00.000Z",
					},
				});
				await sink({ type: "run.completed", runId: request.runId, stopReason: "completed" });
			},
		);

		const server = await startBeeServer();

		try {
			server.input.write(
				frame({
					id: "msg-artifact",
					type: "command",
					name: "turn.start",
					time: new Date().toISOString(),
					sessionId: "session-123",
					turnId: "turn-artifact",
					from: { kind: "human", id: "U123" },
					to: { kind: "agent", id: "agent:bee-pi-agent" },
					replyTo: null,
					payload: {
						input: [{ kind: "text", text: "Create a chart." }],
					},
				}),
			);

			await vi.waitFor(() => {
				expect(server.messages.length).toBe(3);
			});

			expect(server.messages[0]).toMatchObject({
				type: "event",
				name: "item.appended",
				turnId: "turn-artifact",
				payload: {
					eventType: "item.appended",
					item: {
						id: "persisted-assistant-message",
						kind: "message",
						parts: [{ kind: "text", text: "Here is the chart." }],
					},
				},
			});
			expect(server.messages[1]).toMatchObject({
				type: "event",
				name: "item.appended",
				turnId: "turn-artifact",
				time: "2026-08-03T12:02:00.000Z",
				payload: {
					eventType: "item.appended",
					item: {
						id: "ref-artifact",
						kind: "artifact",
						references: ["persisted-assistant-message"],
						parts: [
							expect.objectContaining({
								kind: "artifactRef",
								name: "likes.png",
								title: "likes.png",
								mimeType: "image/png",
								sizeBytes: expect.any(Number),
							}),
						],
					},
				},
			});

			const artifactRef = (
				server.messages[1] as {
					payload: {
						item: { parts: Array<{ kind: string; uri?: string; sizeBytes?: number; mimeType?: string }> };
					};
				}
			).payload.item.parts[0];
			expect(artifactRef.mimeType).toBe("image/png");
			expect(artifactRef.uri).toMatch(/^data:image\/png;base64,/);
			expect(artifactRef.sizeBytes).toBeGreaterThan(0);

			const png = Buffer.from(artifactRef.uri?.replace(/^data:image\/png;base64,/, "") || "", "base64");
			expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		} finally {
			await server.close();
		}
	});

	it("embeds artifacts up to the 5 MB default inline limit", async () => {
		const previousLimit = process.env.BEE_PI_AGENT_ARTIFACT_INLINE_MAX_BYTES;
		const csvSizeBytes = 4_900_000;
		delete process.env.BEE_PI_AGENT_ARTIFACT_INLINE_MAX_BYTES;
		runWorkerMock.mockImplementation(
			async (request: InternalWorkerRunRequest, runtimeConfig: WorkerRuntimeConfig, sink) => {
				const blobStore = new WorkerLocalBlobStore(runtimeConfig.blobStore.rootDir);
				const artifact = await blobStore.putArtifact({
					namespace: `artifacts/${request.sessionId}/${request.runId}`,
					data: Buffer.alloc(csvSizeBytes, "a"),
					name: "report.csv",
					title: "report.csv",
					mimeType: "text/csv",
				});
				await sink({ type: "artifact.created", runId: request.runId, artifact });
				await sink({ type: "run.completed", runId: request.runId, stopReason: "completed" });
			},
		);

		const server = await startBeeServer();

		try {
			server.input.write(
				frame({
					id: "msg-large-artifact",
					type: "command",
					name: "turn.start",
					time: new Date().toISOString(),
					sessionId: "session-123",
					turnId: "turn-large-artifact",
					from: { kind: "human", id: "U123" },
					to: { kind: "agent", id: "agent:bee-pi-agent" },
					replyTo: null,
					payload: {
						input: [{ kind: "text", text: "Create a CSV." }],
					},
				}),
			);

			await vi.waitFor(() => {
				expect(server.messages.length).toBe(2);
			});

			const artifactRef = (
				server.messages[0] as {
					payload: {
						item: { parts: Array<{ kind: string; uri?: string; sizeBytes?: number; mimeType?: string }> };
					};
				}
			).payload.item.parts[0];
			expect(artifactRef.mimeType).toBe("text/csv");
			expect(artifactRef.sizeBytes).toBe(csvSizeBytes);
			expect(artifactRef.uri).toMatch(/^data:text\/csv;base64,/);
		} finally {
			if (previousLimit === undefined) {
				delete process.env.BEE_PI_AGENT_ARTIFACT_INLINE_MAX_BYTES;
			} else {
				process.env.BEE_PI_AGENT_ARTIFACT_INLINE_MAX_BYTES = previousLimit;
			}
			await server.close();
		}
	});

	it("maps worker exceptions to run.failed Bee Dance event envelopes", async () => {
		runWorkerMock.mockRejectedValue(new Error("model unavailable"));

		const server = await startBeeServer();

		try {
			server.input.write(
				frame({
					id: "msg-20",
					type: "command",
					name: "turn.start",
					time: new Date().toISOString(),
					sessionId: "session-err",
					turnId: "turn-err",
					from: { kind: "human", id: "U999" },
					to: { kind: "agent", id: "agent:bee-pi-agent" },
					replyTo: null,
					payload: {
						input: [{ kind: "text", text: "Use a missing model." }],
						hints: {
							conversationId: "slack:T999:C999:1711111111_000200",
							actor: { userId: "U999", userName: "error-user" },
						},
					},
				}),
			);

			await vi.waitFor(() => {
				expect(server.messages.length).toBe(1);
			});

			expect(server.messages[0]).toMatchObject({
				type: "event",
				name: "run.failed",
				sessionId: "session-err",
				turnId: "turn-err",
				from: { kind: "agent", id: "agent:bee-pi-agent" },
				to: { kind: "human", id: "U999" },
				payload: { eventType: "run.failed", error: "model unavailable" },
			});
		} finally {
			await server.close();
		}
	});
});
