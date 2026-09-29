/**
 * The two rails around the input box.
 *
 * A rail is a list of segments, each with an emoji that matches what it
 * reports, a color, and a priority. Rendering is two steps: `fitSegments` drops
 * the least important segments until the row fits, then the row is painted.
 * That ordering is the whole responsive story — a 40-column terminal shows the
 * model and the context, a 120-column terminal shows everything, and nothing in
 * between gets truncated mid-word.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { fit } from "./box.ts";
import { formatDuration } from "./format.ts";
import { type FaikuInfo, contextLabel, costLabel, locationLabel, shortModel, tokenLabel } from "./info.ts";
import { dim, paint, type FaikuColor } from "./palette.ts";

export interface Segment {
	/** Emoji that names the thing, e.g. 🧠 for the model. */
	emoji?: string;
	text: string;
	color: FaikuColor;
	/** Higher is dropped first when the row is too narrow. */
	priority: number;
	/** Paint the whole segment dimmed, for hints rather than facts. */
	muted?: boolean;
}

/** Gap between segments; two spaces, as opencode pads its own rails. */
export const SEGMENT_GAP = "  ";

function segment(emoji: string | undefined, text: string | undefined, color: FaikuColor, priority: number, muted = false): Segment | undefined {
	if (text === undefined || text === "") return undefined;
	return { emoji, text, color, priority, muted };
}

/** Facts above the box: who is answering, and from what. */
export function headerSegments(info: FaikuInfo): Segment[] {
	const segments = [
		segment("🧠", shortModel(info.model), "primary", 100),
		segment("🔀", info.provider, "secondary", 90),
		segment("🔁", info.thinking && info.thinking !== "off" ? `thinking ${info.thinking}` : undefined, "accent", 80),
		segment("🧮", contextLabel(info), "cyan", 70),
		segment("🔢", tokenLabel(info), "muted", 60),
		segment("💲", costLabel(info), "green", 50),
		segment("⏱", info.elapsedMs > 0 ? formatDuration(info.elapsedMs) : undefined, "muted", 40),
	];
	return segments.filter((entry): entry is Segment => entry !== undefined);
}

/** Facts below the box: where you are, and what has changed. */
export function railLeftSegments(info: FaikuInfo): Segment[] {
	const dirty: string[] = [];
	if (info.dirtyChanged !== null && info.dirtyChanged > 0) dirty.push(`✚${info.dirtyChanged}`);
	if (info.dirtyUntracked !== null && info.dirtyUntracked > 0) dirty.push(`＋${info.dirtyUntracked}`);
	const segments = [
		segment("📁", locationLabel(info), "muted", 100),
		segment("🌿", info.branch ?? undefined, "green", 90),
		segment(undefined, dirty.join(" "), "yellow", 80),
		segment("⏱", info.elapsedMs > 0 ? formatDuration(info.elapsedMs) : undefined, "muted", 30),
	];
	return segments.filter((entry): entry is Segment => entry !== undefined);
}

/** Keys, right-aligned under the box. */
export function railRightSegments(): Segment[] {
	return [
		{ emoji: "⏎", text: "send", color: "muted", priority: 100, muted: true },
		{ emoji: "⇧⏎", text: "newline", color: "muted", priority: 90, muted: true },
		{ emoji: "/", text: "commands", color: "muted", priority: 80, muted: true },
		{ emoji: "⌃c", text: "copy", color: "muted", priority: 70, muted: true },
		{ emoji: "⌃v", text: "paste", color: "muted", priority: 60, muted: true },
	];
}

function plain(seg: Segment): string {
	return `${seg.emoji ? `${seg.emoji} ` : ""}${seg.text}`;
}

function width(segments: Segment[]): number {
	if (segments.length === 0) return 0;
	return segments.reduce((total, seg) => total + visibleWidth(plain(seg)), 0) + SEGMENT_GAP.length * (segments.length - 1);
}

/**
 * Drop the least important segments until the row fits.
 *
 * Ties break on the later segment, so a pair of equal-priority facts keeps the
 * one that reads first.
 */
export function fitSegments(segments: Segment[], available: number, gap = SEGMENT_GAP): Segment[] {
	const kept = [...segments];
	const total = (): number =>
		kept.length === 0 ? 0 : kept.reduce((sum, seg) => sum + visibleWidth(plain(seg)), 0) + gap.length * (kept.length - 1);
	while (kept.length > 1 && total() > available) {
		let worst = 0;
		for (let i = 1; i < kept.length; i++) {
			if (kept[i].priority <= kept[worst].priority) worst = i;
		}
		kept.splice(worst, 1);
	}
	return kept;
}

function paintSegment(seg: Segment): string {
	const body = seg.emoji ? `${seg.emoji} ${seg.text}` : seg.text;
	return seg.muted ? dim(paint(seg.color, body)) : paint(seg.color, body);
}

/** The segments painted and joined, at their natural width. */
function painted(segments: Segment[]): string {
	return segments.map(paintSegment).join(SEGMENT_GAP);
}

export function renderSegments(segments: Segment[], available: number): string {
	if (segments.length === 0 || available <= 0) return "";
	return fit(painted(fitSegments(segments, available)), available);
}

/** The line above the box. */
export function renderHeader(info: FaikuInfo, available: number): string {
	return renderSegments(headerSegments(info), available);
}

/** Remove the least important segment, breaking ties on the later one. */
function dropLeastImportant(segments: Segment[]): void {
	let worst = 0;
	for (let i = 1; i < segments.length; i++) {
		if (segments[i].priority <= segments[worst].priority) worst = i;
	}
	segments.splice(worst, 1);
}

/**
 * The line below the box: facts on the left, keys on the right, separated by
 * the space that is left over.
 *
 * Both sides are measured at their natural width first, because a side that has
 * already been stretched to the full width would leave no room for the other.
 * When they do not both fit, the hints give way first, one at a time and least
 * important first — a keystroke reminder is worth less than the branch you are
 * on — and the facts only start going when there is nothing left of the hints.
 */
export function renderHintRail(info: FaikuInfo, available: number): string {
	if (available <= 0) return "";
	const facts = railLeftSegments(info);
	// Already in descending priority, so the last one is the first to go.
	const hints = [...railRightSegments()];
	const fits = (left: Segment[], right: Segment[]): boolean =>
		width(left) + (right.length === 0 ? 0 : width(right) + 3) <= available;

	while (hints.length > 0 && !fits(facts, hints)) hints.pop();
	while (facts.length > 1 && !fits(facts, hints)) dropLeastImportant(facts);

	const left = painted(facts);
	const right = painted(hints);
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth === 0) return fit(right, available);
	if (rightWidth > 0 && leftWidth + rightWidth + 3 <= available) {
		return fit(`${left}${" ".repeat(available - leftWidth - rightWidth)}${right}`, available);
	}
	return renderSegments(facts, available);
}
