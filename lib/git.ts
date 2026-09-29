/**
 * Git facts for the hint rail.
 *
 * The branch is read straight from `.git/HEAD`, because that is a single small
 * file and the rail redraws every second. The dirty counts need `git status`,
 * so they are probed on a timer, off the render path, and cached: a render must
 * never wait on a subprocess.
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** `.git` for `cwd`, walking up. Handles plain repos and worktrees alike. */
export async function findGitDir(cwd: string): Promise<string | null> {
	let current = resolve(cwd);
	for (let depth = 0; depth < 64; depth++) {
		const candidate = join(current, ".git");
		try {
			const info = await stat(candidate);
			return info.isDirectory() ? candidate : resolveGitDirFile(candidate);
		} catch {
			// Keep walking: this directory simply is not the repository root.
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

/** A worktree's `.git` is a file holding `gitdir: <path>`. */
async function resolveGitDirFile(file: string): Promise<string | null> {
	try {
		const text = await readFile(file, "utf8");
		const match = /^gitdir:\s*(.+)$/m.exec(text);
		return match ? resolve(match[1].trim()) : null;
	} catch {
		return null;
	}
}

/**
 * The current branch name, `"detached"` on a detached HEAD, or `null` outside a
 * repository or when the file cannot be read.
 */
export async function readGitBranch(cwd: string): Promise<string | null> {
	const gitDir = await findGitDir(cwd);
	if (!gitDir) return null;
	try {
		const head = await readFile(join(gitDir, "HEAD"), "utf8");
		const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
		if (ref) return ref[1].trim();
		return /^[0-9a-f]{7,40}$/i.test(head.trim()) ? "detached" : null;
	} catch {
		return null;
	}
}

export interface DirtyCounts {
	/** Tracked files that are modified, staged or deleted. */
	changed: number;
	/** Untracked files and directories. */
	untracked: number;
}

export interface DirtyProbe {
	/** Last known counts, or `null` before the first probe lands. */
	get(): DirtyCounts | null;
	/** Ask for a probe if the cache is stale. Safe to call on a timer. */
	refresh(): void;
	/** Forget the cache, e.g. after the working directory changes. */
	invalidate(): void;
	dispose(): void;
}

export interface DirtyProbeOptions {
	/** Minimum gap between two `git status` runs. */
	minIntervalMs?: number;
	/** Give up on a probe that hangs. */
	timeoutMs?: number;
	/** Injected clock, so the interval is testable. */
	now?: () => number;
	/** Injected runner, so the tests need no repository. */
	run?: (cwd: string) => Promise<string>;
}

const DEFAULT_INTERVAL = 4000;
const DEFAULT_TIMEOUT = 3000;

/** Count porcelain status lines by code, ignoring renames' source entries. */
export function parsePorcelain(output: string): DirtyCounts {
	let changed = 0;
	let untracked = 0;
	for (const line of output.split("\n")) {
		if (line.trim() === "") continue;
		const code = line.slice(0, 2);
		if (code === "??") {
			untracked++;
			continue;
		}
		// `R  old -> new` reports one change, not two: skip the source half.
		if (code.includes("R")) continue;
		changed++;
	}
	return { changed, untracked };
}

const defaultRun = (cwd: string, timeoutMs: number): Promise<string> =>
	new Promise((done, fail) => {
		execFile(
			"git",
			["status", "--porcelain", "--untracked-files=normal"],
			{ cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout) => (error ? fail(error) : done(stdout)),
		);
	});

export function createDirtyProbe(cwd: string, options: DirtyProbeOptions = {}): DirtyProbe {
	const minIntervalMs = options.minIntervalMs ?? DEFAULT_INTERVAL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
	const now = options.now ?? Date.now;
	const run = options.run ?? ((dir: string) => defaultRun(dir, timeoutMs));
	let counts: DirtyCounts | null = null;
	// The first probe always runs, however fresh the clock looks.
	let lastProbe = Number.NEGATIVE_INFINITY;
	let inFlight = false;
	let disposed = false;

	function refresh(): void {
		if (disposed || inFlight) return;
		const at = now();
		if (at - lastProbe < minIntervalMs) return;
		inFlight = true;
		lastProbe = at;
		run(cwd)
			.then((output) => {
				counts = parsePorcelain(output);
			})
			.catch(() => {
				// Not a repository, git missing, or the probe timed out: the rail
				// simply has nothing to say, and the next tick tries again.
			})
			.finally(() => {
				inFlight = false;
			});
	}

	return {
		get: () => counts,
		refresh,
		invalidate() {
			counts = null;
			lastProbe = Number.NEGATIVE_INFINITY;
		},
		dispose() {
			disposed = true;
			counts = null;
		},
	};
}
