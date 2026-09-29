/**
 * The session facts the box and the rail display.
 *
 * Collection is a snapshot function, not a subscription: the editor asks for
 * the current facts on every render, and the extension decides when to collect
 * them. Everything it cannot know is `null` rather than a guess, so the rail
 * drops a segment instead of lying about it.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatInt, formatPercent, formatTokens, shortenPath } from "./format.ts";

export interface FaikuInfo {
	/** Active model id, e.g. `claude-sonnet-4-5`. */
	model?: string;
	/** Provider serving it, e.g. `anthropic`. */
	provider?: string;
	/** Current thinking level, e.g. `medium`; absent when the model has none. */
	thinking?: string;
	/** Context window used, 0-100; `null` until pi can measure it. */
	contextPercent: number | null;
	/** Estimated context tokens, `null` when unknown. */
	contextTokens: number | null;
	/** Session input tokens, summed over the active branch. */
	tokensIn: number;
	/** Session output tokens, summed over the active branch. */
	tokensOut: number;
	/** Session cost in USD, or `null` when no model reported pricing. */
	cost: number | null;
	/** Working directory. */
	cwd: string;
	/** Git branch, `null` outside a repository. */
	branch: string | null;
	/** Tracked files changed, `null` before the first probe. */
	dirtyChanged: number | null;
	/** Untracked files, `null` before the first probe. */
	dirtyUntracked: number | null;
	/** Milliseconds the agent has spent working this session, not wall time. */
	elapsedMs: number;
	/** False while the agent is streaming. */
	idle: boolean;
}

export function emptyInfo(): FaikuInfo {
	return {
		contextPercent: null,
		contextTokens: null,
		tokensIn: 0,
		tokensOut: 0,
		cost: null,
		cwd: "",
		branch: null,
		dirtyChanged: null,
		dirtyUntracked: null,
		elapsedMs: 0,
		idle: true,
	};
}

export interface SessionTotals {
	tokensIn: number;
	tokensOut: number;
	cost: number;
}

/**
 * Sum the usage of every assistant message on the active branch.
 *
 * The branch matters: a session that was rewound must not keep adding up the
 * messages the user just left behind.
 */
export function sessionTotals(entries: readonly { type: string; message?: unknown }[]): SessionTotals {
	let tokensIn = 0;
	let tokensOut = 0;
	let cost = 0;
	let priced = false;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; usage?: Usage } | undefined;
		if (message?.role !== "assistant" || !message.usage) continue;
		const usage = message.usage;
		tokensIn += usage.input ?? 0;
		tokensOut += usage.output ?? 0;
		const total = usage.cost?.total;
		if (typeof total === "number" && Number.isFinite(total)) {
			cost += total;
			priced = true;
		}
	}
	return { tokensIn, tokensOut, cost: priced ? cost : 0 };
}

export interface CollectOptions {
	/** Working time so far, from the extension's clock. */
	elapsedMs?: number;
	/** Git branch, already resolved by the extension. */
	branch?: string | null;
	/** Git status counts, already resolved by the extension. */
	dirty?: { changed: number; untracked: number } | null;
	/** Show cost even when no model priced the session. */
	showCost?: boolean;
}

/** Take a snapshot of everything the rail can show, from one context. */
export function collectInfo(ctx: ExtensionContext, options: CollectOptions): FaikuInfo {
	const usage = ctx.getContextUsage?.();
	const totals = sessionTotals(ctx.sessionManager.getBranch() as readonly { type: string; message?: unknown }[]);
	return {
		model: ctx.model?.id,
		provider: ctx.model?.provider,
		thinking: ctx.thinkingLevel,
		contextPercent: typeof usage?.percent === "number" ? usage.percent : null,
		contextTokens: typeof usage?.tokens === "number" ? usage.tokens : null,
		tokensIn: totals.tokensIn,
		tokensOut: totals.tokensOut,
		cost: options.showCost === false ? null : totals.cost,
		cwd: ctx.cwd,
		branch: options.branch ?? null,
		dirtyChanged: options.dirty?.changed ?? null,
		dirtyUntracked: options.dirty?.untracked ?? null,
		elapsedMs: Math.max(0, options.elapsedMs ?? 0),
		idle: ctx.isIdle(),
	};
}

/** `anthropic/claude-sonnet-4-5` -> `claude-sonnet-4-5`, dropping known noise. */
export function shortModel(id: string | undefined): string | undefined {
	if (!id) return undefined;
	const withoutProvider = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
	return withoutProvider.trim() === "" ? undefined : withoutProvider;
}

/** The header's context segment, e.g. `12% · 18.4k`. */
export function contextLabel(info: FaikuInfo): string | undefined {
	if (info.contextPercent === null) return undefined;
	const percent = formatPercent(info.contextPercent);
	return info.contextTokens === null ? percent : `${percent} · ${formatTokens(info.contextTokens)}`;
}

/** The rail's location segment, e.g. `code/pi-faiku-theme`. */
export function locationLabel(info: FaikuInfo): string | undefined {
	if (info.cwd === "") return undefined;
	return shortenPath(info.cwd, 2);
}

/** The rail's session totals, e.g. `↑4.2k ↓980`. */
export function tokenLabel(info: FaikuInfo): string | undefined {
	if (info.tokensIn === 0 && info.tokensOut === 0) return undefined;
	return `↑${formatTokens(info.tokensIn)} ↓${formatTokens(info.tokensOut)}`;
}

/** The cost segment, e.g. `$0.42`, only when something was actually priced. */
export function costLabel(info: FaikuInfo): string | undefined {
	if (info.cost === null || info.cost <= 0) return undefined;
	return `$${info.cost < 0.01 ? info.cost.toFixed(4) : info.cost.toFixed(2)}`;
}

/** The integer part of a char count, for toasts. */
export function charCount(value: number): string {
	return formatInt(value);
}
