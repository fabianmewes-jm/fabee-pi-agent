import { isAbsolute, resolve } from "node:path";

export interface OutputPathGuard {
	resolve(requestedPath: string, operation: "Writes" | "Edits"): string;
	directoryCommand(directory: string, createDirectory: boolean): string;
}

export function createOutputPathGuard(outputRoot: string, additionalRoots: string[] = []): OutputPathGuard {
	const root = resolve(outputRoot);
	const roots = [...new Set([root, ...additionalRoots.map((entry) => resolve(entry))])];
	const contains = (candidateRoot: string, target: string) =>
		target === candidateRoot || target.startsWith(`${candidateRoot}/`);
	const matchingRoot = (target: string) => roots.find((candidateRoot) => contains(candidateRoot, target));

	return {
		resolve(requestedPath, operation) {
			const target = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
			if (!matchingRoot(target)) {
				throw new Error(`${operation} are limited to configured output directories: ${roots.join(", ")}`);
			}
			return target;
		},
		directoryCommand(directory, createDirectory) {
			const allowedRoot = matchingRoot(resolve(directory));
			if (!allowedRoot) throw new Error(`Directory is outside configured output directories: ${directory}`);
			const escapedRoot = shellEscape(allowedRoot);
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
