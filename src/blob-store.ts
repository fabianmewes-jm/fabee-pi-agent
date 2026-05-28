import { randomUUID } from "crypto";
import { copyFile, mkdir, stat, writeFile } from "fs/promises";
import { dirname, extname, join } from "path";
import type { WorkerArtifactRef, WorkerAttachmentInput, WorkerRuntimeConfig } from "./types.js";

function sanitizeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildBlobKey(namespace: string, blobId: string, name?: string): string {
	const cleanNamespace = namespace
		.split("/")
		.filter(Boolean)
		.map((part) => sanitizeSegment(part))
		.join("/");
	const cleanName = name ? sanitizeSegment(name) : undefined;
	return cleanName ? `${cleanNamespace}/${blobId}-${cleanName}` : `${cleanNamespace}/${blobId}`;
}

async function ensureParent(targetPath: string): Promise<void> {
	await mkdir(dirname(targetPath), { recursive: true });
}

export interface MaterializedBlob {
	path: string;
	filename: string;
	cleanup?: () => Promise<void>;
}

export class WorkerLocalBlobStore {
	constructor(private rootDir: string) {}

	async materialize(ref: WorkerAttachmentInput | WorkerArtifactRef): Promise<MaterializedBlob> {
		const localPath = join(this.rootDir, ref.blobKey);
		return {
			path: localPath,
			filename:
				ref.name || ref.title || `${"artifactId" in ref ? ref.artifactId : ref.attachmentId}${extname(localPath)}`,
		};
	}

	async putArtifact(args: {
		namespace: string;
		filePath?: string;
		data?: Buffer;
		name?: string;
		title?: string;
		mimeType?: string;
	}): Promise<WorkerArtifactRef> {
		if (!args.filePath && !args.data) {
			throw new Error("putArtifact requires either filePath or data");
		}
		const artifactId = randomUUID();
		const blobKey = buildBlobKey(args.namespace, artifactId, args.name);
		const targetPath = join(this.rootDir, blobKey);
		await ensureParent(targetPath);
		if (args.data) {
			await writeFile(targetPath, args.data);
		} else if (args.filePath) {
			await copyFile(args.filePath, targetPath);
		}
		const details = await stat(targetPath);
		return {
			artifactId,
			blobKey,
			name: args.name,
			title: args.title || args.name,
			mimeType: args.mimeType,
			sizeBytes: details.size,
		};
	}
}

export function createWorkerBlobStore(runtimeConfig: WorkerRuntimeConfig): WorkerLocalBlobStore {
	return new WorkerLocalBlobStore(runtimeConfig.blobStore.rootDir);
}
