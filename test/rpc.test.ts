import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

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
							actor: { userId: "U123", userName: "gunnar" },
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
					actor: expect.objectContaining({ userId: "U123", userName: "gunnar" }),
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
