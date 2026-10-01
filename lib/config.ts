/**
 * Faiku configuration, read from the global `settings.json` under the `faiku`
 * key. Every field is optional; the defaults are the whole experience, so a
 * fresh install needs no configuration at all.
 */

import { type CollapseMode, parseCollapseMode } from "./collapse.ts";
import { DEFAULT_MAX_VISIBLE } from "./history.ts";
import { DEFAULT_MAX_TABS, MAX_CLOSED } from "./tabs.ts";

export type Padding = "comfortable" | "compact";

export type { CollapseMode };

export interface FaikuConfig {
	/** Master switch. Off restores pi's own editor, theme and overlays. */
	enabled: boolean;
	/** Draw the opencode-style input box. */
	box: boolean;
	/** Show the top-right copy/paste notifications. */
	toasts: boolean;
	/** Select the `faiku` theme when a session starts. */
	applyTheme: boolean;
	/** Facts above the box: model, provider, thinking, context, tokens, cost. */
	header: boolean;
	/** Facts and keys below the box: location, branch, dirty counts, timer. */
	hintRail: boolean;
	/** Poll git for changed and untracked counts. */
	gitStatus: boolean;
	/** Show the timer: how long the agent has been working this session. */
	elapsed: boolean;
	/** Show the history panel above the box when arrow up walks back. */
	history: boolean;
	/** Pin a row of session tabs to the top of the terminal. */
	tabs: boolean;
	/**
	 * May this package put pi into fullscreen mode, which the tab bar and every
	 * click need? `false` is the user's own decision, kept across restarts.
	 */
	fullscreen: boolean;
	/** Which blocks start collapsed: all, thinking, tools or off. */
	collapse: CollapseMode;
	/** Blank row above and below the input, or a tight box. */
	padding: Padding;
	/** Placeholder shown while the input is empty. */
	placeholder: string;
	/** How long a toast stays up. */
	toastTtlMs: number;
	/** Toast width in columns. */
	toastWidth: number;
	/** How many prompts the history panel shows at once. */
	historyMaxVisible: number;
	/** How many chats the tab bar shows. */
	tabsMax: number;
	/** Session paths hidden from the tab bar, most recently closed first. */
	tabsClosed: string[];
	/** Keys for the tab bar's slots, over the defaults in `lib/tabs.ts`. */
	tabKeys: Record<string, string>;
}

export const DEFAULT_CONFIG: FaikuConfig = {
	enabled: true,
	box: true,
	toasts: true,
	applyTheme: true,
	header: true,
	hintRail: true,
	gitStatus: true,
	elapsed: true,
	history: true,
	tabs: true,
	fullscreen: true,
	collapse: "all",
	padding: "comfortable",
	placeholder: "Ask anything…",
	toastTtlMs: 2500,
	toastWidth: 30,
	historyMaxVisible: DEFAULT_MAX_VISIBLE,
	tabsMax: DEFAULT_MAX_TABS,
	tabsClosed: [],
	tabKeys: {},
};

/** Below this the box stops pretending to be a box and pi's own editor returns. */
export const MIN_BOX_WIDTH = 24;
/** Below this the vertical padding is dropped, then the header. */
export const MIN_COMFORTABLE_WIDTH = 40;

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function text(value: unknown, fallback: string, max = 60): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (trimmed === "") return fallback;
	return trimmed.slice(0, max);
}

/** A `{ slot: key }` map, keeping only entries that look like key ids. */
function keyBindings(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const kept: Record<string, string> = {};
	for (const [slot, key] of Object.entries(value as Record<string, unknown>)) {
		if (typeof key !== "string") continue;
		const trimmed = key.trim().toLowerCase();
		// An empty string is kept: it is how a slot is unbound, and dropping it
		// would silently hand the default key back.
		if (trimmed === "" || trimmed.length <= 32) kept[slot] = trimmed;
	}
	return kept;
}

/** Session paths, de-duplicated and kept in the order they were closed. */
function paths(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed === "" || seen.has(trimmed)) continue;
		seen.add(trimmed);
		kept.push(trimmed);
		if (kept.length === MAX_CLOSED) break;
	}
	return kept;
}

/** Parse the `faiku` block, ignoring anything of the wrong type. */
export function parseConfig(settings: Record<string, unknown>): FaikuConfig {
	const raw = settings.faiku;
	const block = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		enabled: bool(block.enabled, DEFAULT_CONFIG.enabled),
		box: bool(block.box, DEFAULT_CONFIG.box),
		toasts: bool(block.toasts, DEFAULT_CONFIG.toasts),
		applyTheme: bool(block.applyTheme, DEFAULT_CONFIG.applyTheme),
		header: bool(block.header, DEFAULT_CONFIG.header),
		hintRail: bool(block.hintRail, DEFAULT_CONFIG.hintRail),
		gitStatus: bool(block.gitStatus, DEFAULT_CONFIG.gitStatus),
		elapsed: bool(block.elapsed, DEFAULT_CONFIG.elapsed),
		history: bool(block.history, DEFAULT_CONFIG.history),
		tabs: bool(block.tabs, DEFAULT_CONFIG.tabs),
		fullscreen: bool(block.fullscreen, DEFAULT_CONFIG.fullscreen),
		collapse: parseCollapseMode(block.collapse, DEFAULT_CONFIG.collapse),
		padding: block.padding === "compact" ? "compact" : DEFAULT_CONFIG.padding,
		placeholder: text(block.placeholder, DEFAULT_CONFIG.placeholder),
		toastTtlMs: int(block.toastTtlMs, DEFAULT_CONFIG.toastTtlMs, 400, 20000),
		toastWidth: int(block.toastWidth, DEFAULT_CONFIG.toastWidth, 18, 60),
		historyMaxVisible: int(block.historyMaxVisible, DEFAULT_CONFIG.historyMaxVisible, 1, 20),
		tabsMax: int(block.tabsMax, DEFAULT_CONFIG.tabsMax, 1, 20),
		tabsClosed: paths(block.tabsClosed),
		tabKeys: keyBindings(block.tabKeys),
	};
}

/** Serialize the configuration back into a settings patch. */
export function configPatch(config: FaikuConfig, changes: Partial<FaikuConfig> = {}): Record<string, unknown> {
	const next = { ...config, ...changes };
	return { faiku: { ...next } };
}

/** The configuration as `/faiku info` prints it. */
export function describeConfig(config: FaikuConfig): string {
	const onOff = (value: boolean): string => (value ? "on" : "off");
	return [
		`enabled    ${onOff(config.enabled)}`,
		`box        ${onOff(config.box)}`,
		`toasts     ${onOff(config.toasts)}`,
		`theme      ${onOff(config.applyTheme)}`,
		`header     ${onOff(config.header)}`,
		`hint rail  ${onOff(config.hintRail)}`,
		`git status ${onOff(config.gitStatus)}`,
		`elapsed    ${onOff(config.elapsed)}`,
		`history    ${onOff(config.history)}, ${config.historyMaxVisible} rows`,
		`tabs       ${onOff(config.tabs)}, ${config.tabsMax} chats, ${config.tabsClosed.length} closed`,
		`fullscreen ${onOff(config.fullscreen)} may switch pi's TUI mode`,
		`collapse   ${config.collapse}`,
		`padding    ${config.padding}`,
		`toast      ${config.toastWidth} cols, ${config.toastTtlMs} ms`,
	].join("\n");
}
