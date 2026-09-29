/**
 * Top-right notifications.
 *
 * Copy and paste are silent in a terminal, which is exactly why they are worth
 * a notification: the toast is the only feedback that a clipboard round trip
 * happened, and it reports the size of the payload so a collapsed multi-line
 * paste is not a mystery. Toasts are a store plus a pure renderer; the overlay
 * that hosts them is the extension's job, so this file has no terminal in it.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { fit, GLYPHS, sideRow, topBorder, bottomBorder, joinParts } from "./box.ts";
import { type FaikuColor, paint } from "./palette.ts";

export type ToastKind = "copy" | "paste" | "image" | "info" | "warning" | "error";

/** One emoji per kind, chosen for what the event did rather than how it looks. */
export const TOAST_EMOJI: Record<ToastKind, string> = {
	copy: "📋",
	paste: "📥",
	image: "🖼️",
	info: "ℹ️",
	warning: "⚠️",
	error: "❌",
};

const TOAST_COLOR: Record<ToastKind, FaikuColor> = {
	copy: "primary",
	paste: "cyan",
	image: "accent",
	info: "secondary",
	warning: "orange",
	error: "red",
};

export interface Toast {
	id: number;
	kind: ToastKind;
	/** What happened, e.g. `Copied`. */
	label: string;
	/** How much, e.g. `142 chars`. Omitted when unknown. */
	detail?: string;
	createdAt: number;
}

export interface ToastStore {
	/** Add a toast and return it. */
	push(kind: ToastKind, label: string, detail?: string): Toast;
	/** Remove everything older than the TTL. Returns true when the list changed. */
	tick(now?: number): boolean;
	/** Live toasts, newest first. */
	items(): Toast[];
	clear(): void;
	/** True when anything is on screen. */
	has(): boolean;
}

export interface ToastStoreOptions {
	/** How long a toast stays up. */
	ttlMs?: number;
	/** How many are on screen at once; the oldest is dropped. */
	max?: number;
	/** Injected clock, so the TTL is testable. */
	now?: () => number;
}

export const DEFAULT_TTL_MS = 2500;
export const DEFAULT_MAX_TOASTS = 3;

/**
 * Same-kind toasts inside this window are one event seen twice — a keypress
 * that reaches both the global input listener and the editor, for instance — so
 * the second is swallowed instead of stacking.
 */
const DEDUPE_MS = 250;

export function createToastStore(options: ToastStoreOptions = {}): ToastStore {
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const max = Math.max(1, options.max ?? DEFAULT_MAX_TOASTS);
	const now = options.now ?? Date.now;
	let nextId = 1;
	let items: Toast[] = [];

	return {
		push(kind, label, detail) {
			const at = now();
			const newest = items[0];
			if (newest && newest.kind === kind && newest.label === label && at - newest.createdAt < DEDUPE_MS) {
				return newest;
			}
			const toast: Toast = { id: nextId++, kind, label, detail, createdAt: at };
			items = [toast, ...items].slice(0, max);
			return toast;
		},
		tick(at = now()) {
			const kept = items.filter((toast) => at - toast.createdAt < ttlMs);
			if (kept.length === items.length) return false;
			items = kept;
			return true;
		},
		items: () => [...items],
		clear: () => {
			items = [];
		},
		has: () => items.length > 0,
	};
}

/**
 * Render the stack, newest on top, each one a three-line square box.
 *
 * ```
 * ┌──────────────────────────┐
 * │ 📋  Copied      142 chars │
 * └──────────────────────────┘
 * ```
 */
export function renderToasts(items: readonly Toast[], available: number): string[] {
	if (items.length === 0 || available < 12) return [];
	const lines: string[] = [];
	for (const toast of items) {
		const color = TOAST_COLOR[toast.kind];
		const emoji = TOAST_EMOJI[toast.kind];
		const label = `${emoji}  ${toast.label}`;
		const inner = Math.max(0, available - 4);
		const body = toast.detail ? spaceBetween(label, toast.detail, inner) : fit(label, inner);
		lines.push(paint(color, joinParts(topBorder(available, undefined, GLYPHS.square))));
		lines.push(paint(color, sideRow(` ${body} `, available, GLYPHS.square)));
		lines.push(paint(color, joinParts(bottomBorder(available, undefined, GLYPHS.square))));
	}
	return lines;
}

/** `left` and `right` on one line, or just `left` when both will not fit. */
function spaceBetween(left: string, right: string, available: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + rightWidth + 2 > available) return fit(left, available);
	const label = paint("foreground", left);
	const detail = paint("muted", right);
	return `${label}${" ".repeat(available - leftWidth - rightWidth)}${detail}`;
}
