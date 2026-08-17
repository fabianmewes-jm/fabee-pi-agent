import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";

const writeSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're writing (shown to user)" }),
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export function createWriteTool(executor: Executor, writableRoot: string): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description: "Write content to a session output file. Creates parent directories and overwrites existing files.",
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path, content }: { label: string; path: string; content: string },
			signal?: AbortSignal,
		) => {
			const targetPath = assertWritablePath(path, writableRoot);
			const dir = targetPath.substring(0, targetPath.lastIndexOf("/"));
			const cmd = `${writableDirectoryGuard(writableRoot, dir)} && test ! -L ${shellEscape(targetPath)} && printf '%s' ${shellEscape(content)} > ${shellEscape(targetPath)}`;
			const result = await executor.exec(cmd, { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr || `Failed to write file: ${path}`);
			}

			return {
				content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
				details: undefined,
			};
		},
	};
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function writableDirectoryGuard(root: string, directory: string): string {
	const escapedRoot = shellEscape(resolve(root));
	const escapedDirectory = shellEscape(directory);
	return `mkdir -p ${escapedRoot} && root_real=$(realpath ${escapedRoot}) && probe=${escapedDirectory} && while [ ! -e "$probe" ]; do parent=$(dirname "$probe"); [ "$parent" != "$probe" ] || exit 73; probe="$parent"; done && probe_real=$(realpath "$probe") && case "$probe_real" in "$root_real"|"$root_real"/*) ;; *) echo 'Output path escapes through a symlink' >&2; exit 73;; esac && mkdir -p ${escapedDirectory} && dir_real=$(realpath ${escapedDirectory}) && case "$dir_real" in "$root_real"|"$root_real"/*) ;; *) echo 'Output path escapes through a symlink' >&2; exit 73;; esac`;
}

function assertWritablePath(path: string, writableRoot: string): string {
	const root = resolve(writableRoot);
	const target = resolve(root, path);
	if (target !== root && !target.startsWith(`${root}/`)) {
		throw new Error(`Writes are limited to the session output directory: ${root}`);
	}
	return target;
}
