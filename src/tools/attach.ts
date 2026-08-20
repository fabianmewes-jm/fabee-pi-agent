import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { basename, extname, resolve as resolvePath } from "path";
import { BUILTIN_TOOL_TITLES } from "./titles.js";

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

function mimeTypeForPath(path: string): string | undefined {
	switch (extname(path).toLowerCase()) {
		case ".csv":
			return "text/csv";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".svg":
			return "image/svg+xml";
		case ".pdf":
			return "application/pdf";
		case ".json":
			return "application/json";
		case ".html":
		case ".htm":
			return "text/html";
		default:
			return undefined;
	}
}

export function createAttachTool(uploadFn: ArtifactHandler): AgentTool<typeof attachSchema> {
	return {
		name: "attach",
		label: BUILTIN_TOOL_TITLES.attach,
		description:
			"Send/expose a file path as a worker artifact event for the gateway or orchestrator. This is the only built-in tool that sends attachments.",
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
			await uploadFn({
				path: absolutePath,
				name: basename(absolutePath),
				title: fileName,
				mimeType: mimeTypeForPath(absolutePath),
			});

			return {
				content: [{ type: "text" as const, text: `Registered artifact: ${fileName}` }],
				details: undefined,
			};
		},
	};
}
