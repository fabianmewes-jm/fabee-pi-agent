import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { basename, resolve as resolvePath } from "path";

export type ArtifactInput =
	| {
			path: string;
			name?: string;
			title?: string;
			mimeType?: string;
	  }
	| {
			data: Buffer;
			name: string;
			title?: string;
			mimeType: string;
	  };

export type ArtifactHandler = (artifact: ArtifactInput) => Promise<void>;

const attachSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're sharing (shown to user)" }),
	path: Type.String({ description: "Path to the file to expose as a worker artifact" }),
	title: Type.Optional(Type.String({ description: "Optional title for the artifact" })),
});

export function createAttachTool(uploadFn: ArtifactHandler): AgentTool<typeof attachSchema> {
	return {
		name: "attach",
		label: "attach",
		description: "Expose a file path as a worker artifact event for the gateway or orchestrator.",
		parameters: attachSchema,
		execute: async (
			_toolCallId: string,
			{ path, title }: { label: string; path: string; title?: string },
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const absolutePath = resolvePath(path);
			const fileName = title || basename(absolutePath);
			await uploadFn({ path: absolutePath, name: basename(absolutePath), title: fileName });

			return {
				content: [{ type: "text" as const, text: `Registered artifact: ${fileName}` }],
				details: undefined,
			};
		},
	};
}
