/**
 * Faiku configuration, read from the global `settings.json` under the `faiku`
 * key. Every field is optional; the defaults are the whole experience, so a
 * fresh install needs no configuration at all.
 */

export type Padding = "comfortable" | "compact";

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
	/** Show the session timer. */
	elapsed: boolean;
	/** Blank row above and below the input, or a tight box. */
	padding: Padding;
	/** Placeholder shown while the input is empty. */
	placeholder: string;
	/** How long a toast stays up. */
	toastTtlMs: number;
	/** Toast width in columns. */
	toastWidth: number;
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
	padding: "comfortable",
	placeholder: "Ask anything…",
	toastTtlMs: 2500,
	toastWidth: 30,
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
		padding: block.padding === "compact" ? "compact" : DEFAULT_CONFIG.padding,
		placeholder: text(block.placeholder, DEFAULT_CONFIG.placeholder),
		toastTtlMs: int(block.toastTtlMs, DEFAULT_CONFIG.toastTtlMs, 400, 20000),
		toastWidth: int(block.toastWidth, DEFAULT_CONFIG.toastWidth, 18, 60),
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
		`padding    ${config.padding}`,
		`toast      ${config.toastWidth} cols, ${config.toastTtlMs} ms`,
	].join("\n");
}
