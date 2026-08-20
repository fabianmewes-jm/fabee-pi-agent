import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createToolLifecycleTracker } from "../src/tool-lifecycle.js";
import { BUILTIN_TOOL_TITLES } from "../src/tools/titles.js";

function tool(name: string, label?: string): AgentTool<any> {
	return { name, label } as AgentTool<any>;
}

describe("tool lifecycle", () => {
	it("defines the user-facing titles for every built-in tool", () => {
		expect(BUILTIN_TOOL_TITLES).toEqual({
			read: "Datei lesen",
			bash: "Befehl ausführen",
			edit: "Datei bearbeiten",
			write: "Datei schreiben",
			attach: "Datei anhängen",
			dbt: "Datenabfrage ausführen",
			chart: "Grafik erzeugen",
			company_briefing: "Unternehmensbriefing erstellen",
			market_insights: "Gehaltsdaten analysieren",
		});
	});

	it("preserves distinct Pi call IDs and separates static titles from dynamic labels", () => {
		let timestamp = 100;
		const tracker = createToolLifecycleTracker([tool("read", BUILTIN_TOOL_TITLES.read)], () => timestamp);
		const first = tracker.start("run-1", {
			toolCallId: "call-1",
			toolName: "read",
			args: { label: "Konfiguration prüfen", path: "config.json" },
		});
		timestamp = 145;
		const second = tracker.start("run-1", {
			toolCallId: "call-2",
			toolName: "read",
			args: { label: "Dokumentation lesen", path: "README.md" },
		});
		timestamp = 180;
		const firstCompleted = tracker.complete("run-1", {
			toolCallId: "call-1",
			toolName: "read",
			isError: false,
		});

		expect(first).toMatchObject({
			type: "tool.started",
			toolCallId: "call-1",
			title: "Datei lesen",
			label: "Konfiguration prüfen",
		});
		expect(second).toMatchObject({ toolCallId: "call-2", title: "Datei lesen", label: "Dokumentation lesen" });
		expect(firstCompleted).toMatchObject({
			type: "tool.completed",
			toolCallId: "call-1",
			title: "Datei lesen",
			label: "Konfiguration prüfen",
			success: true,
			durationMs: 80,
		});
		expect(firstCompleted).not.toHaveProperty("result");
	});

	it("uses an extension label and then its name as the static-title fallback", () => {
		const tracker = createToolLifecycleTracker([tool("custom_labeled", "Bericht prüfen"), tool("custom_plain")]);

		expect(tracker.start("run-1", { toolCallId: "call-1", toolName: "custom_labeled", args: {} }).title).toBe(
			"Bericht prüfen",
		);
		expect(tracker.start("run-1", { toolCallId: "call-2", toolName: "custom_plain", args: {} }).title).toBe(
			"custom_plain",
		);
	});
});
