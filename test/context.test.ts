import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerSettingsManager } from "../src/context.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "fabee-pi-agent-context-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("createWorkerSettingsManager", () => {
	it("applies worker retry settings", () => {
		const manager = createWorkerSettingsManager(createTemporaryDirectory(), {
			maxRetries: 6,
			baseDelayMs: 2_000,
		});

		expect(manager.getRetrySettings()).toEqual({
			enabled: true,
			maxRetries: 6,
			baseDelayMs: 2_000,
		});
	});

	it("preserves unrelated persisted settings while overriding retry limits", () => {
		const directory = createTemporaryDirectory();
		writeFileSync(
			join(directory, "settings.json"),
			JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 1 } }),
		);

		const manager = createWorkerSettingsManager(directory, {
			maxRetries: 5,
			baseDelayMs: 1_000,
		});

		expect(manager.getCompactionSettings().enabled).toBe(false);
		expect(manager.getRetrySettings()).toEqual({
			enabled: true,
			maxRetries: 5,
			baseDelayMs: 1_000,
		});
	});
});
