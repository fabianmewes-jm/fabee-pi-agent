import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { type OutputPathGuard, shellEscape } from "./output-path.js";

const writeSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're writing (shown to user)" }),
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export function createWriteTool(executor: Executor, outputPaths: OutputPathGuard): AgentTool<typeof writeSchema> {
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
			const targetPath = outputPaths.resolve(path, "Writes");
			const dir = targetPath.substring(0, targetPath.lastIndexOf("/"));
			const cmd = `${outputPaths.directoryCommand(dir, true)} && test ! -L ${shellEscape(targetPath)} && printf '%s' ${shellEscape(content)} > ${shellEscape(targetPath)}`;
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
