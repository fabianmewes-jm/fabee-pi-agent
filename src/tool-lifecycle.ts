import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkerRunEvent } from "./types.js";

interface ToolExecutionStartEvent {
	toolCallId: string;
	toolName: string;
	args: unknown;
}

interface ToolExecutionEndEvent {
	toolCallId: string;
	toolName: string;
	isError: boolean;
}

interface PendingToolExecution {
	toolName: string;
	title: string;
	label?: string;
	args: Record<string, unknown>;
	startTime: number;
}

export interface ToolLifecycleTracker {
	start(runId: string, event: ToolExecutionStartEvent): Extract<WorkerRunEvent, { type: "tool.started" }>;
	complete(runId: string, event: ToolExecutionEndEvent): Extract<WorkerRunEvent, { type: "tool.completed" }>;
}

function toArgs(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function dynamicLabel(args: Record<string, unknown>): string | undefined {
	return typeof args.label === "string" && args.label.trim() ? args.label : undefined;
}

/** Correlates Pi tool events while keeping the emitted lifecycle transport-neutral. */
export function createToolLifecycleTracker(
	tools: AgentTool<any>[],
	now: () => number = Date.now,
): ToolLifecycleTracker {
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const pending = new Map<string, PendingToolExecution>();
	const titleFor = (toolName: string): string => toolsByName.get(toolName)?.label || toolName;

	return {
		start(runId, event) {
			const args = toArgs(event.args);
			const label = dynamicLabel(args);
			const title = titleFor(event.toolName);
			pending.set(event.toolCallId, {
				toolName: event.toolName,
				title,
				label,
				args,
				startTime: now(),
			});
			return {
				type: "tool.started",
				runId,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				title,
				label,
				args,
			};
		},
		complete(runId, event) {
			const tracked = pending.get(event.toolCallId);
			pending.delete(event.toolCallId);
			return {
				type: "tool.completed",
				runId,
				toolCallId: event.toolCallId,
				toolName: tracked?.toolName || event.toolName,
				title: tracked?.title || titleFor(event.toolName),
				success: !event.isError,
				durationMs: tracked ? now() - tracked.startTime : 0,
				label: tracked?.label,
				args: tracked?.args,
			};
		},
	};
}
