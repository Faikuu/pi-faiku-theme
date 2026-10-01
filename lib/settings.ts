/**
 * Reading and writing `<agent-dir>/settings.json`.
 *
 * Copied in spirit from the sibling package: settings are merged, never
 * rewritten. Writes are **atomic** — the new contents go to a temporary file in
 * the same directory and are then renamed over the old one — because this is a
 * file other code reads without asking. pi parses `settings.json` from
 * extensions while they are still loading, and a plain truncate-then-write puts
 * an empty or half-written file in front of that reader for the length of the
 * write. A rename cannot be observed halfway, so a reader sees the old file or
 * the new one and never a broken one.
 *
 * The write is also not serialized against pi's own saves: pi's settings
 * storage takes a lockfile, and this package has no business reaching for it.
 * Merging means a lost race costs one field, never a corrupt file — and the
 * next session asks again.
 */

import { readFile, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Resolve the pi agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (configured && configured.trim() !== "") return expandHome(configured.trim(), env);
	return join(homedir(), ".pi", "agent");
}

export function expandHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	const home = env.HOME ?? env.USERPROFILE;
	if (path.startsWith("~") && home) return join(home, path.slice(1));
	return path;
}

export function globalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "settings.json");
}

/** Read a settings file, returning `{}` when it is missing or malformed. */
export async function readSettings(file: string): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		return {};
	} catch {
		return {};
	}
}

/** Merge `patch` into a settings file, preserving unrelated keys. */
export async function writeSettings(file: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
	const next = { ...(await readSettings(file)), ...patch };
	await mkdir(dirname(file), { recursive: true });
	await replaceFile(file, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

/**
 * Put `contents` in `file` in one step, or not at all.
 *
 * The temporary file is a sibling so the rename stays on one filesystem, where
 * it is atomic, and its permissions are copied from the file being replaced —
 * a rename swaps the inode, so a fresh temporary file would otherwise quietly
 * tighten or loosen the settings file's mode.
 */
async function replaceFile(file: string, contents: string): Promise<void> {
	const mode = await fileMode(file);
	const temporary = join(dirname(file), `.${process.pid}.${Date.now()}.${basename(file)}.tmp`);
	try {
		await writeFile(temporary, contents, { encoding: "utf8", mode });
		try {
			await rename(temporary, file);
		} catch (error) {
			// Windows refuses to rename over an existing file. Losing atomicity
			// beats losing the setting, and this is the platform where pi's own
			// settings writes are least likely to be read mid-write anyway.
			if (!isReplaceRefused(error)) throw error;
			await writeFile(file, contents, { encoding: "utf8", mode });
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

async function fileMode(file: string): Promise<number> {
	try {
		const info = await stat(file);
		return info.mode & 0o777;
	} catch {
		// A new settings file: owner only, which is what pi uses for its own.
		return 0o600;
	}
}

function isReplaceRefused(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = String(error.code);
	return code === "EPERM" || code === "EEXIST" || code === "EACCES" || code === "ENOTEMPTY";
}
