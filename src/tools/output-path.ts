import { resolve } from "node:path";

export interface OutputPathGuard {
	resolve(requestedPath: string, operation: "Writes" | "Edits"): string;
	directoryCommand(directory: string, createDirectory: boolean): string;
}

export function createOutputPathGuard(outputRoot: string): OutputPathGuard {
	const root = resolve(outputRoot);

	return {
		resolve(requestedPath, operation) {
			const target = resolve(root, requestedPath);
			if (target !== root && !target.startsWith(`${root}/`)) {
				throw new Error(`${operation} are limited to the session output directory: ${root}`);
			}
			return target;
		},
		directoryCommand(directory, createDirectory) {
			const escapedRoot = shellEscape(root);
			const escapedDirectory = shellEscape(directory);
			const prefix = `mkdir -p ${escapedRoot} && root_real=$(realpath ${escapedRoot})`;
			const verifyDirectory = `dir_real=$(realpath ${escapedDirectory}) && case "$dir_real" in "$root_real"|"$root_real"/*) ;; *) echo 'Output path escapes through a symlink' >&2; exit 73;; esac`;

			if (!createDirectory) return `${prefix} && ${verifyDirectory}`;

			const verifyExistingAncestor = `probe=${escapedDirectory} && while [ ! -e "$probe" ]; do parent=$(dirname "$probe"); [ "$parent" != "$probe" ] || exit 73; probe="$parent"; done && probe_real=$(realpath "$probe") && case "$probe_real" in "$root_real"|"$root_real"/*) ;; *) echo 'Output path escapes through a symlink' >&2; exit 73;; esac`;
			return `${prefix} && ${verifyExistingAncestor} && mkdir -p ${escapedDirectory} && ${verifyDirectory}`;
		},
	};
}

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
