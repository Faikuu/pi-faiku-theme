/**
 * Prompt history, and the panel that browses it.
 *
 * Arrow up already does something in pi: it walks back through the prompts you
 * have sent, one keystroke at a time, and you can only see the one you are on.
 * The panel is that same walk made visible. It is a list, not a search, so a
 * prompt is one glance away instead of three more presses of a key you have to
 * remember:
 *
 * ```
 * ┌─ history ──────────────────────────────────┐
 * │   add a toast when a file is written       │
 * │ ❯ refactor the parser into lib/parse.ts    │
 * └────────────────────────────────────────────┘
 * ```
 *
 * The store mirrors pi's own editor history exactly — same trimming, same
 * refusal to record the same prompt twice in a row, same cap — because the
 * panel is not a second history, it is a view of the first one. The editor
 * keeps both in step and owns the keystrokes; this file owns the list and the
 * drawing, and knows nothing about the terminal beyond the width it is given.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type BorderPart, bottomBorder, GLYPHS, sideRowParts, topBorder } from "./box.ts";
import { paint } from "./palette.ts";

/** pi's own cap, kept so the panel and the base never disagree about the list. */
export const DEFAULT_MAX_HISTORY = 100;
/** How many entries the panel shows before it starts sliding. */
export const DEFAULT_MAX_VISIBLE = 6;
/** The marker on the entry that will be restored, gap included. */
export const MARKER = "❯ ";
/** Columns the marker takes on every row, so the prompts stay in one column. */
const MARKER_WIDTH = visibleWidth(MARKER);
/** One space of padding inside each rule. */
const ROW_PAD = 1;
/** Below this the panel would be a stack of stubs, so it is not drawn at all. */
const MIN_PANEL_WIDTH = 20;

export interface HistoryStore {
	/** Record a submitted prompt. Mirrors pi: trimmed, no empty, no immediate repeat. */
	add(text: string): void;
	/** Prompts, newest first. */
	entries(): readonly string[];
	/** Where a prompt sits in the list, or -1 when it is not in it. */
	indexOf(text: string): number;
	/** How many prompts are remembered. */
	size(): number;
	/** True when there is something to browse. */
	has(): boolean;
}

export interface HistoryStoreOptions {
	/** How many prompts to keep. */
	max?: number;
}

export function createHistoryStore(options: HistoryStoreOptions = {}): HistoryStore {
	const max = Math.max(1, options.max ?? DEFAULT_MAX_HISTORY);
	let items: string[] = [];

	return {
		add(text) {
			const trimmed = text.trim();
			if (trimmed === "") return;
			// The same prompt sent twice in a row is one prompt, as far as the
			// base is concerned; the panel must not offer it twice.
			if (items[0] === trimmed) return;
			items = [trimmed, ...items].slice(0, max);
		},
		entries: () => [...items],
		indexOf(text) {
			return items.indexOf(text);
		},
		size: () => items.length,
		has: () => items.length > 0,
	};
}

/**
 * One prompt, on one row: line breaks and runs of spaces collapsed, then cut
 * to the width with an ellipsis so a truncated prompt is visibly truncated
 * rather than silently wrong.
 */
export function shortenPrompt(text: string, width: number): string {
	if (width <= 0) return "";
	const flat = text.replace(/\s+/g, " ").trim();
	return truncateToWidth(flat, width, "…");
}

export interface HistoryWindow {
	/** First entry shown, counted from the newest. */
	start: number;
	/** One past the last entry shown. */
	end: number;
}

/**
 * The slice of the list the panel shows, as `[start, end)`.
 *
 * The selection is always inside the window, the newest entry sits at the
 * bottom when nothing has been scrolled past, and the window slides down by
 * exactly one entry per keystroke rather than jumping to the far end.
 */
export function historyWindow(count: number, selected: number, visible: number): HistoryWindow {
	const size = Math.max(0, Math.min(count, visible));
	if (size === 0) return { start: 0, end: 0 };
	const anchor = Math.min(Math.max(selected, 0), count - 1);
	let start = Math.max(0, anchor - size + 1);
	start = Math.min(start, Math.max(0, count - size));
	return { start, end: start + size };
}

/** The keys, set into the bottom rule; the border drops them when it will not fit. */
export const PANEL_HINT = "↵ restore · esc cancel";

/** A rule with its label in the same cyan the input box uses for its labels. */
function paintRule(parts: BorderPart[]): string {
	return parts
		.map((part) => (part.kind === "label" ? paint("cyan", part.text) : paint("border", part.text)))
		.join("");
}

/**
 * The panel: a square box above the input, newest prompt at the bottom and the
 * entry that will be restored marked with the input's own prompt glyph.
 *
 * Square corners on purpose — a rounded frame is the input box, and this is
 * not one. `selected` indexes the same list the store hands out, so the marker
 * always sits on the prompt that is actually in the editor.
 */
export function renderHistory(entries: readonly string[], selected: number, available: number, maxVisible = DEFAULT_MAX_VISIBLE): string[] {
	if (entries.length === 0 || available < MIN_PANEL_WIDTH) return [];
	const { start, end } = historyWindow(entries.length, selected, Math.max(1, maxVisible));
	const inner = available - 2;
	const textWidth = Math.max(1, inner - ROW_PAD * 2 - MARKER_WIDTH);
	const rows: string[] = [];

	// The list is newest first and the panel is read from the bottom up, so the
	// oldest entry of the window is drawn first: further up the panel is further
	// back in time, and the newest prompt sits next to the input.
	for (let index = end - 1; index >= start; index--) {
		const active = index === selected;
		const marker = active ? paint("primary", MARKER) : " ".repeat(MARKER_WIDTH);
		const text = shortenPrompt(entries[index], textWidth);
		const body = `${" ".repeat(ROW_PAD)}${marker}${paint(active ? "foreground" : "muted", text)}${" ".repeat(ROW_PAD)}`;
		const parts = sideRowParts(body, available, GLYPHS.square);
		rows.push(`${paint("border", parts.left.text)}${parts.interior}${parts.fill}${paint("border", parts.right.text)}`);
	}

	return [
		paintRule(topBorder(available, "history", GLYPHS.square)),
		...rows,
		paintRule(bottomBorder(available, PANEL_HINT, GLYPHS.square)),
	];
}
