/**
 * Box drawing.
 *
 * Pure geometry, no colors: every helper returns parts the caller paints, so the
 * same code draws the rounded input box, the square toast box and the tests
 * without a theme in the way. Width is measured in terminal columns, never in
 * string length, and every line is fitted to the width it was handed.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const GLYPHS = {
	/** The input box: opencode's soft, rounded frame. */
	rounded: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	/** Toasts: square corners, so a notification never reads as the editor. */
	square: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" },
} as const;

export type GlyphName = keyof typeof GLYPHS;
export type Glyphs = (typeof GLYPHS)[GlyphName];

export type BorderKind = "corner" | "fill" | "label";

export interface BorderPart {
	text: string;
	kind: BorderKind;
}

/** Truncate and pad to exactly `width` columns, ANSI-safe. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "");
	const fill = width - visibleWidth(clipped);
	// Truncation closes any style it cut into. A reset the caller did not ask
	// for would flatten the border this row is about to be framed with.
	const hadReset = text.endsWith("\x1b[0m");
	const padded = fill > 0 ? clipped + " ".repeat(fill) : clipped;
	return hadReset ? padded : padded.replace(/\x1b\[0m$/, "");
}

function borderParts(left: string, right: string, width: number, label: string | undefined, glyphs: Glyphs): BorderPart[] {
	if (width <= 0) return [];
	if (width === 1) return [{ text: left, kind: "corner" }];
	const inner = width - 2;
	const text = label && label.trim() !== "" ? ` ${label.trim()} ` : "";
	if (text === "" || visibleWidth(text) + 1 > inner) {
		return [
			{ text: left, kind: "corner" },
			{ text: glyphs.horizontal.repeat(inner), kind: "fill" },
			{ text: right, kind: "corner" },
		];
	}
	const before = 1;
	const after = inner - before - visibleWidth(text);
	return [
		{ text: left, kind: "corner" },
		{ text: glyphs.horizontal.repeat(before), kind: "fill" },
		{ text, kind: "label" },
		{ text: glyphs.horizontal.repeat(after), kind: "fill" },
		{ text: right, kind: "corner" },
	];
}

export function topBorder(width: number, label?: string, glyphs: Glyphs = GLYPHS.rounded): BorderPart[] {
	return borderParts(glyphs.topLeft, glyphs.topRight, width, label, glyphs);
}

export function bottomBorder(width: number, label?: string, glyphs: Glyphs = GLYPHS.rounded): BorderPart[] {
	return borderParts(glyphs.bottomLeft, glyphs.bottomRight, width, label, glyphs);
}

/**
 * One framed row: vertical rule, interior fitted to `width - 2`, vertical rule.
 * A row narrower than three columns degrades to a single rule.
 */
export function sideRow(interior: string, width: number, glyphs: Glyphs = GLYPHS.rounded): string {
	if (width <= 0) return "";
	if (width === 1) return glyphs.vertical;
	const rule = glyphs.vertical.repeat(1);
	return `${rule}${fit(interior, width - 2)}${rule}`;
}

/** The same row, but with the interior split so the caller can color it. */
export interface SideRow {
	left: BorderPart;
	interior: string;
	right: BorderPart;
	fill: string;
	innerWidth: number;
}

export function sideRowParts(interior: string, width: number, glyphs: Glyphs = GLYPHS.rounded): SideRow {
	const innerWidth = Math.max(0, width - 2);
	const clipped = truncateToWidth(interior, innerWidth, "");
	return {
		left: { text: glyphs.vertical, kind: "corner" },
		right: { text: glyphs.vertical, kind: "corner" },
		interior: clipped,
		fill: " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped))),
		innerWidth,
	};
}

/** Join plain parts into one line. */
export function joinParts(parts: BorderPart[]): string {
	return parts.map((part) => part.text).join("");
}
