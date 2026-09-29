/**
 * Faiku configuration, read from the global `settings.json` under the `faiku`
 * key. Every field is optional; the defaults are the whole experience, so a
 * fresh install needs no configuration at all.
 */

import { type CollapseMode, parseCollapseMode } from "./collapse.ts";
import { DEFAULT_FADE_MS, DEFAULT_FADE_RATE, MAX_FADE_MS, MAX_FADE_RATE, MIN_FADE_MS, MIN_FADE_RATE } from "./fade.ts";
import { DEFAULT_MAX_VISIBLE } from "./history.ts";

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
	/** Reveal text that arrived in one chunk instead of all at once. */
	fade: boolean;
	/** How long the current backlog of characters should take to clear. */
	fadeMs: number;
	/** Ceiling on the reveal rate, in characters a second. */
	fadeRate: number;
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
	fade: true,
	fadeMs: DEFAULT_FADE_MS,
	fadeRate: DEFAULT_FADE_RATE,
	collapse: "all",
	padding: "comfortable",
	placeholder: "Ask anything…",
	toastTtlMs: 2500,
	toastWidth: 30,
	historyMaxVisible: DEFAULT_MAX_VISIBLE,
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
		fade: bool(block.fade, DEFAULT_CONFIG.fade),
		fadeMs: int(block.fadeMs, DEFAULT_CONFIG.fadeMs, MIN_FADE_MS, MAX_FADE_MS),
		fadeRate: int(block.fadeRate, DEFAULT_CONFIG.fadeRate, MIN_FADE_RATE, MAX_FADE_RATE),
		collapse: parseCollapseMode(block.collapse, DEFAULT_CONFIG.collapse),
		padding: block.padding === "compact" ? "compact" : DEFAULT_CONFIG.padding,
		placeholder: text(block.placeholder, DEFAULT_CONFIG.placeholder),
		toastTtlMs: int(block.toastTtlMs, DEFAULT_CONFIG.toastTtlMs, 400, 20000),
		toastWidth: int(block.toastWidth, DEFAULT_CONFIG.toastWidth, 18, 60),
		historyMaxVisible: int(block.historyMaxVisible, DEFAULT_CONFIG.historyMaxVisible, 1, 20),
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
		`fade       ${onOff(config.fade)}, ${config.fadeMs} ms, ${config.fadeRate} chars/s`,
		`collapse   ${config.collapse}`,
		`padding    ${config.padding}`,
		`toast      ${config.toastWidth} cols, ${config.toastTtlMs} ms`,
	].join("\n");
}
