/**
 * Taking pi's editor rendering apart and putting ours back together.
 *
 * `Editor.render` already does the hard work: word wrap, scroll offset, the
 * hardware cursor marker, autocomplete placement. So the Faiku box never
 * re-implements layout — it calls the base renderer and reframes the result:
 * the base's top border becomes a titled top rule, its text lines gain vertical
 * rules, and its autocomplete rows move inside the frame.
 *
 * That means the base's own borders have to be found in its output. The base
 * records how many text lines it drew, and when that count is unavailable the
 * fallback looks for the last line that is made of border glyphs.
 */

import { stripAnsi } from "./palette.ts";

export interface EditorFrame {
	/** The base's top border line, kept for its scroll or status label. */
	top: string;
	/** The base's text lines, already padded to the base's content width. */
	content: string[];
	/** The base's bottom border line. */
	bottom: string;
	/** Autocomplete rows, which pi draws after the bottom border. */
	extra: string[];
}

/** The base editor's private bookkeeping, read defensively. */
export function readVisibleLineCount(editor: object): number | undefined {
	const value = (editor as { renderedVisibleLineCount?: unknown }).renderedVisibleLineCount;
	return typeof value === "number" && value >= 0 ? value : undefined;
}

/**
 * Whether a line looks like one of the base's borders.
 *
 * A scroll hint is a rule run with `↑ 3 more` set into it, so the label is
 * removed before the shape is judged. A border that is nothing but a label, or
 * pi's own status border, is not recognized — which is why this is only the
 * fallback for when the base's line count is unavailable.
 */
function looksLikeBorder(line: string): boolean {
	const plain = stripAnsi(line)
		.replace(/[↑↓]\s*\d+\s*more/g, "")
		.trim();
	if (plain === "") return false;
	return /^[─━═\s]*$/.test(plain) && /[─━═]/.test(plain);
}

/**
 * Split `Editor.render` output into its four regions.
 *
 * `visibleCount` is what the base just drew; without it the bottom border is
 * found by shape, which is safe because text lines are always padded on the
 * left and a line of nothing but rules is not a line anybody types.
 */
export function splitEditorLines(raw: readonly string[], visibleCount?: number): EditorFrame {
	const top = raw[0] ?? "";
	const rest = raw.slice(1);
	const known = visibleCount !== undefined && visibleCount <= rest.length - 1 ? visibleCount : undefined;
	let bottomIndex: number;
	if (known !== undefined) {
		bottomIndex = known;
	} else {
		bottomIndex = -1;
		for (let i = rest.length - 1; i >= 0; i--) {
			if (looksLikeBorder(rest[i])) {
				bottomIndex = i;
				break;
			}
		}
	}
	if (bottomIndex < 0) return { top, content: rest, bottom: "", extra: [] };
	return {
		top,
		content: rest.slice(0, bottomIndex),
		bottom: rest[bottomIndex] ?? "",
		extra: rest.slice(bottomIndex + 1),
	};
}

/** `↑ 3 more` / `↓ 12 more` -> `3`, the hidden-line count pi encoded. */
export function readScrollLabel(line: string, direction: "↑" | "↓"): string | undefined {
	const match = new RegExp(`${direction}\\s*(\\d+)\\s*more`).exec(stripAnsi(line));
	return match ? `${direction} ${match[1]} more` : undefined;
}

/**
 * Whatever else pi embedded in a border line — the working spinner and its
 * message — as plain text, with the rule glyphs and the scroll label removed.
 */
export function readBorderLabel(line: string): string | undefined {
	const plain = stripAnsi(line);
	if (plain.trim() === "") return undefined;
	const words = plain
		.split(/[─\s]+/)
		.map((word) => word.trim())
		.filter((word) => word !== "" && !/^[↑↓]$/.test(word) && !/^\d+$/.test(word) && word !== "more");
	const label = words.join(" ").trim();
	return label === "" ? undefined : label;
}
