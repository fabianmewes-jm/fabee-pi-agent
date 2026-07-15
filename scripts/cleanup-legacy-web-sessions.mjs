#!/usr/bin/env node

import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const LEGACY_PREFIX = "fabee-pi-agent:web:";
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const stateDir = args.find((arg) => !arg.startsWith("--"));

if (!stateDir) {
	console.error("Usage: cleanup-legacy-web-sessions.mjs <state-dir> [--execute]");
	process.exit(2);
}

const sessionsDir = join(stateDir, "sessions");
const logsDir = join(stateDir, "logs");
const sessionEntries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
const sessionPaths = sessionEntries
	.filter((entry) => entry.isDirectory() && entry.name.startsWith(LEGACY_PREFIX))
	.map((entry) => join(sessionsDir, entry.name));

const logEntries = await readdir(logsDir, { withFileTypes: true }).catch(() => []);
const logPaths = [];
for (const entry of logEntries) {
	if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
	const path = join(logsDir, entry.name);
	const content = await readFile(path, "utf8");
	const belongsToLegacyWebSession = content.split("\n").some((line) => {
		if (!line) return false;
		try {
			const event = JSON.parse(line);
			return event.type === "run.requested" && event.sessionId?.startsWith(LEGACY_PREFIX);
		} catch {
			return false;
		}
	});
	if (belongsToLegacyWebSession) logPaths.push(path);
}

const targets = [...sessionPaths, ...logPaths];
console.log(`${execute ? "Removing" : "Would remove"} ${targets.length} legacy Fabee web paths:`);
for (const path of targets) console.log(path);

if (!execute) {
	console.log("Dry run only. Re-run with --execute after reviewing the paths.");
	process.exit(0);
}

for (const path of targets) await rm(path, { recursive: true });
console.log("Cleanup complete. Slack and non-Fabee-web data were not selected.");
