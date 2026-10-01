/**
 * Sticky session tabs.
 *
 * pi has one session per process and no tabs, so a tab here is a pi session
 * file for this working directory: the bar is the most recent handful of them,
 * the one you are in is marked, and switching means `switchSession`. That is why
 * this file knows nothing about terminals — it turns a list of sessions into a
 * bar, a list of hit regions, and nothing else. The overlay, the mouse and the
 * command are the extension's job, the same split the toast stack uses.
 *
 * ```
 *  ❯ refactor parser │ api cleanup │ ⚡ fix box │ + ──────────────────
 * ────────────────────────────────────────────────────────────────────
 * ```
 *
 * Two rules keep the bar honest on a narrow terminal: a label is clipped rather
 * than wrapped, and tabs are dropped from the right — except the current one,
 * which is always drawn, because a bar that hides where you are is worse than a
 * bar with fewer tabs.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fit } from "./box.ts";
import { paint, stripAnsi } from "./palette.ts";

/** How many chats the bar shows unless the settings say otherwise. */
export const DEFAULT_MAX_TABS = 8;
/** Below this the bar is more noise than navigation, and the overlay hides. */
export const MIN_BAR_WIDTH = 40;
/** Longest a label may be before it is clipped, so one chat cannot eat the bar. */
export const MAX_LABEL_WIDTH = 24;
/** How many closed session paths are remembered. */
export const MAX_CLOSED = 100;

const SEPARATOR = "│";
/** The rule the bar ends with, and the one it draws under itself. */
const RULE = "─";
/** The trailing affordance that starts a new chat. */
export const NEW_CHAT_LABEL = "+";
/** Shown on the tab you are in while the agent works. */
export const BUSY_MARK = "●";
/** Columns kept free at the end of the row for the trailing rule. */
const TAIL_COLUMNS = 2;

/** What the bar needs to know about a session, and nothing else. */
export interface SessionSummary {
	path: string;
	/** User-set name, from `/name`. */
	name?: string;
	firstMessage?: string;
	messageCount: number;
	/** Epoch milliseconds; the bar is ordered by this. */
	modified: number;
}

export interface Tab {
	path: string;
	label: string;
	/** 1-based position on the bar, which is what `/faiku tab <n>` takes. */
	position: number;
	/** True for the session the terminal is showing. */
	current: boolean;
	/** True for the current session while the agent is working. */
	busy: boolean;
	messages: number;
	/** Epoch milliseconds, so a listing can say how old a chat is. */
	modified: number;
}

/** One clickable span of the row, in the overlay's own coordinates. */
export interface TabRegion {
	kind: "tab" | "new";
	/** Index into the tab list; -1 for the new-chat affordance. */
	index: number;
	/** First column, inclusive. */
	start: number;
	/** Last column, exclusive. */
	end: number;
}

/**
 * The keys the bar answers to, by slot.
 *
 * `1`…`9` jump to a chat by position, and `new`, `prev`, `next` do what they
 * say. These are defaults, not a promise: a key only works if the terminal
 * sends the bytes behind it, and on macOS that is a terminal setting rather
 * than a given — `alt+1` is `esc` followed by `1`, which iTerm2, Ghostty and a
 * Terminal set to "Option sends Esc+" produce and a Terminal set to "nothing"
 * never does. `/faiku keys set <slot> <key>` rebinds a slot, and `/faiku keys`
 * reports what the keyboard actually sent, so the table can be matched against
 * a real terminal instead of a guess.
 */
export const DEFAULT_TAB_KEYS: Record<string, string> = {
	"1": "alt+1",
	"2": "alt+2",
	"3": "alt+3",
	"4": "alt+4",
	"5": "alt+5",
	"6": "alt+6",
	"7": "alt+7",
	"8": "alt+8",
	"9": "alt+9",
	new: "alt+0",
	prev: "alt+shift+left",
	next: "alt+shift+right",
};

/** Slots that mean something: a position on the bar, or one of the three verbs. */
export const TAB_SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "new", "prev", "next"] as const;

export type TabSlot = (typeof TAB_SLOTS)[number];

/** What a slot does when its key arrives. */
export function tabSlotAction(slot: string): string | undefined {
	if (TAB_SLOTS.includes(slot as TabSlot)) {
		return slot === "new" ? "new chat" : slot === "prev" || slot === "next" ? `${slot} chat` : `chat ${slot}`;
	}
	return undefined;
}

export interface TabKeyBinding {
	slot: string;
	key: string;
	action: string;
}

/**
 * The bindings to register: defaults, with the user's own keys laid over them.
 *
 * A slot the user set to an empty string is dropped rather than left bound to
 * nothing, which is how a shortcut is turned off without losing the rest.
 */
export function resolveTabKeys(overrides: Record<string, string> = {}): TabKeyBinding[] {
	const bindings: TabKeyBinding[] = [];
	for (const slot of TAB_SLOTS) {
		const key = (overrides[slot] ?? DEFAULT_TAB_KEYS[slot]).trim().toLowerCase();
		if (key === "") continue;
		bindings.push({ slot, key, action: tabSlotAction(slot) ?? slot });
	}
	return bindings;
}

/** `1 alt+1 chat 1` lines, for `/faiku info` and `/faiku keys list`. */
export function describeTabKeys(bindings: readonly TabKeyBinding[]): string {
	if (bindings.length === 0) return "no tab shortcuts are bound";
	return bindings.map((binding) => `${binding.slot}  ${binding.key}  ${binding.action}`).join("\n");
}

export interface TabBar {
	/**
	 * The bar and the rule under it, each already fitted to the width. Empty
	 * below `MIN_BAR_WIDTH`.
	 */
	lines: string[];
	regions: TabRegion[];
	/** The tabs that were drawn, in bar order. */
	shown: Tab[];
}

export interface BuildTabsOptions {
	/** Session file the terminal is showing. */
	currentPath?: string | undefined;
	/** Session paths hidden from the bar, newest close first. */
	closed?: readonly string[];
	/** How many chats fit. */
	max?: number;
	/** Whether the agent is working. */
	busy?: boolean;
}

/** The text on a tab: a name if there is one, otherwise the first thing said. */
export function tabLabel(session: SessionSummary, max: number = MAX_LABEL_WIDTH): string {
	const named = session.name?.trim();
	if (named) return clip(named, max);
	const said = (session.firstMessage ?? "").replace(/\s+/g, " ").trim();
	if (said === "") return "untitled";
	return clip(said, max);
}

function clip(text: string, max: number): string {
	return visibleWidth(text) <= max ? text : truncateToWidth(text, max, "…");
}

/**
 * The bar's tab list: closed sessions gone, newest first, capped.
 *
 * The current session is always in the list even when it is old enough to fall
 * off the end — it takes the last slot and the newest tab gives it up. A bar
 * that has quietly dropped the chat you are in would be a lie about where you
 * are, and an extra row of session metadata is a cheaper price.
 */
export function buildTabs(sessions: readonly SessionSummary[], options: BuildTabsOptions = {}): Tab[] {
	const max = Math.max(1, options.max ?? DEFAULT_MAX_TABS);
	const currentPath = options.currentPath;
	const hidden = new Set(options.closed ?? []);
	const sorted = sessions.filter((session) => !hidden.has(session.path)).sort((a, b) => b.modified - a.modified);
	const kept = sorted.slice(0, max);
	if (currentPath && !kept.some((session) => session.path === currentPath)) {
		const current = sorted.find((session) => session.path === currentPath);
		if (current) {
			kept.pop();
			kept.push(current);
		}
	}
	return kept.map((session, index) => ({
		path: session.path,
		label: tabLabel(session),
		position: index + 1,
		current: session.path === currentPath,
		busy: session.path === currentPath && options.busy === true,
		messages: session.messageCount,
		modified: session.modified,
	}));
}

export interface RenderTabsOptions {
	/** Draw the trailing `+`. Off for a preview that has no new chat to offer. */
	newChat?: boolean;
}

/**
 * The row, and where its clickable parts are.
 *
 * Both come from one pass on purpose: the regions are the columns this render
 * actually used, so a click at column 40 cannot select the tab that was there
 * before the terminal was resized.
 */
export function renderTabs(tabs: readonly Tab[], width: number, options: RenderTabsOptions = {}): TabBar {
	if (width < MIN_BAR_WIDTH) return { lines: [], regions: [], shown: [] };
	const withNewChat = options.newChat !== false;
	const shown = fitTabs(tabs, width, withNewChat ? 3 : 0);

	let line = "";
	let column = 0;
	const regions: TabRegion[] = [];
	for (const tab of shown) {
		if (column > 0) {
			line += paint("border", SEPARATOR);
			column += 1;
		}
		const text = tabSegment(tab);
		regions.push({ kind: "tab", index: tab.position - 1, start: column, end: column + widthOf(text) });
		line += text;
		column += widthOf(text);
	}
	if (withNewChat) {
		const text = ` ${paint("secondary", NEW_CHAT_LABEL)} `;
		regions.push({ kind: "new", index: -1, start: column, end: column + 3 });
		line += text;
		column += 3;
	}
	line += paint("border", "─".repeat(Math.max(0, width - column)));
	// A rule under the bar, in the same colour as the input box's frame: without
	// it the tabs float on top of the transcript and the two read as one thing.
	const rule = paint("border", RULE.repeat(width));
	return { lines: [fit(line, width), rule], regions, shown };
}

/** One tab: a margin, the current-session marker, the label, a busy dot, a gap. */
function tabSegment(tab: Tab): string {
	const marker = tab.current ? paint("primary", "❯") : " ";
	const label = tab.current ? paint("primary", tab.label) : paint("muted", tab.label);
	const busy = tab.busy ? ` ${paint("primary", BUSY_MARK)}` : "";
	return ` ${marker} ${label}${busy} `;
}

function widthOf(text: string): number {
	return visibleWidth(stripAnsi(text));
}

/**
 * The tabs that fit, left to right.
 *
 * The current tab is added last if the cut would have dropped it, which puts it
 * at the right-hand end — the honest place for a session too old to make the
 * cut on its own.
 */
function fitTabs(tabs: readonly Tab[], width: number, reserved: number): Tab[] {
	const chosen: Tab[] = [];
	let used = reserved + TAIL_COLUMNS;
	for (const tab of tabs) {
		const cost = widthOf(tabSegment(tab)) + (chosen.length > 0 ? 1 : 0);
		if (used + cost > width) break;
		used += cost;
		chosen.push(tab);
	}
	const current = tabs.find((tab) => tab.current);
	if (current && !chosen.some((tab) => tab.path === current.path) && chosen.length > 0) {
		chosen.pop();
		chosen.push(current);
	}
	return chosen;
}

/** What is under column `x`, if anything. Separators and the rule are not tabs. */
export function tabAt(regions: readonly TabRegion[], x: number): TabRegion | undefined {
	return regions.find((region) => x >= region.start && x < region.end);
}

/** How long ago a session was last touched: `just now`, `14m`, `3d`. */
export function formatAge(modified: number, now = Date.now()): string {
	const elapsed = now - modified;
	if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** The bar as `/faiku tab` prints it: position, marker, label, size, age. */
export function describeTabs(tabs: readonly Tab[], now = Date.now()): string {
	if (tabs.length === 0) return "No chats to show yet.";
	return tabs
		.map((tab) => {
			const marker = tab.current ? "❯" : " ";
			const busy = tab.busy ? ` ${BUSY_MARK}` : "";
			const messages = `${tab.messages} ${tab.messages === 1 ? "message" : "messages"}`;
			return `${String(tab.position).padStart(2)}. ${marker} ${tab.label}${busy}  ·  ${messages}  ·  ${formatAge(tab.modified, now)}`;
		})
		.join("\n");
}

export interface TabStoreOptions {
	/** Read the sessions for this working directory. */
	load: () => Promise<SessionSummary[]>;
	/** The session file the terminal is showing. */
	currentPath: () => string | undefined;
	closed?: readonly string[];
	max?: number;
	/** How long a loaded list is trusted, in milliseconds. */
	ttlMs?: number;
	/** Injected clock, so the cache is testable. */
	now?: () => number;
}

export interface TabStore {
	/** The bar's tabs, from the last load. Never awaits: this runs on render. */
	tabs(): Tab[];
	/** Reload when the cache is stale. Resolves to true when the bar changed. */
	refresh(options?: { force?: boolean }): Promise<boolean>;
	/** Hide a session and remember it. */
	close(path: string): boolean;
	/** Bring back the most recently closed session. */
	reopen(): string | undefined;
	closed(): string[];
	setClosed(paths: readonly string[]): void;
	setMax(max: number): void;
	setBusy(busy: boolean): void;
}

/**
 * The list behind the bar, with the cache that keeps it cheap.
 *
 * `SessionManager.list` reads every session file in the directory, so it runs on
 * session start and on demand — never on a tick. Between loads the store
 * answers from what it already has, which is what lets `render` stay
 * synchronous.
 */
export function createTabStore(options: TabStoreOptions): TabStore {
	const ttlMs = options.ttlMs ?? 15_000;
	const now = options.now ?? Date.now;
	let sessions: SessionSummary[] = [];
	let closed = [...(options.closed ?? [])];
	let max = options.max ?? DEFAULT_MAX_TABS;
	let busy = false;
	let loadedAt: number | undefined;
	let pending: Promise<boolean> | undefined;

	function current(): Tab[] {
		return buildTabs(sessions, { currentPath: options.currentPath(), closed, max, busy });
	}

	function signature(tabs: readonly Tab[]): string {
		return tabs.map((tab) => `${tab.position}:${tab.path}:${tab.label}`).join("|");
	}

	async function loadSessions(): Promise<boolean> {
		const before = signature(current());
		try {
			sessions = await options.load();
		} catch {
			// A session directory that cannot be read is not worth an error: the
			// bar keeps whatever it had, and the commands still report the problem.
			return false;
		}
		loadedAt = now();
		return signature(current()) !== before;
	}

	return {
		tabs: current,
		refresh(refreshOptions = {}) {
			if (pending) return pending;
			const fresh = loadedAt !== undefined && now() - loadedAt < ttlMs;
			if (fresh && !refreshOptions.force) return Promise.resolve(false);
			pending = loadSessions().finally(() => {
				pending = undefined;
			});
			return pending;
		},
		close(path: string) {
			if (closed.includes(path)) return false;
			closed = [path, ...closed].slice(0, MAX_CLOSED);
			return true;
		},
		reopen() {
			const [path, ...rest] = closed;
			closed = rest;
			return path;
		},
		closed: () => [...closed],
		setClosed(paths: readonly string[]) {
			closed = paths.filter((path) => path !== "").slice(0, MAX_CLOSED);
		},
		setMax(next: number) {
			max = Math.max(1, Math.floor(next));
		},
		setBusy(next: boolean) {
			busy = next;
		},
	};
}