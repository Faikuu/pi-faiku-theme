/**
 * Smooth arrival for streamed text.
 *
 * pi already renders an assistant message as it streams, but a provider that
 * delivers its output in chunks hands pi several hundred characters in one
 * `message_update`, and those land on screen in a single frame. This module
 * turns that instant arrival into a reveal: the characters are released at a
 * steady rate and the newest ones are tinted, so they brighten as they settle.
 *
 * Nothing here knows about pi or about terminals. The extension feeds it
 * lengths and reads back a truncated string to hand pi's markdown transformer,
 * which is why the pacing can be tested with an injected clock.
 *
 * The rules that keep it out of the way:
 *
 * - An arrival of `SMOOTH_THRESHOLD` characters or fewer is released whole.
 *   Token-by-token streaming is already smooth, and delaying it would only add
 *   lag, so the feature stays silent unless a chunk actually lands at once.
 * - The reveal runs at `rate` characters a second at most, paced so that the
 *   current backlog clears within `windowMs`, and never slower than
 *   `rate / TAIL_FRACTION` so the tail of a chunk lands promptly.
 * - Colour is only applied to a plain run of prose. Half-typed markdown and
 *   the inside of a code fence are left for pi's parser, which would rather
 *   not be handed escape sequences.
 */

/** How often the extension asks for a frame while a reveal is running. */
export const FRAME_MS = 33;
/** Arrivals at or below this many characters are already smooth enough. */
export const SMOOTH_THRESHOLD = 12;
/** How long a released character takes to reach its final colour. */
export const RAMP_MS = 220;
/** How many trailing characters may be tinted at once. */
export const RAMP_CHARS = 24;

export const DEFAULT_FADE_MS = 260;
export const MIN_FADE_MS = 80;
export const MAX_FADE_MS = 1500;
/** The reveal ceiling, in characters a second. */
export const DEFAULT_FADE_RATE = 900;
export const MIN_FADE_RATE = 60;
export const MAX_FADE_RATE = 5000;
/**
 * The reveal never falls below a rate of this fraction of the ceiling.
 *
 * Without it the pace would follow the backlog down without end, and the last
 * handful of characters of every chunk would crawl out at a few a second.
 */
export const TAIL_FRACTION = 8;

/** Which stream a reveal belongs to. pi transforms the two separately. */
export type FadeChannel = "assistant" | "assistant-thinking";

export interface FadeOptions {
	/** How long the current backlog should take to clear, in milliseconds. */
	windowMs: number;
	/** Ceiling on the reveal rate, in characters a second. */
	rate: number;
}

/** A run of recently released characters, newest first, with their age. */
export interface RampBand {
	chars: number;
	ageMs: number;
}

/** How a character of a given age should be coloured: 0 dimmest, 2 settled. */
export type TintLevel = 0 | 1 | 2;
export type Tint = (level: TintLevel, text: string) => string;

export interface FadeState {
	/** Record that `segments` is the whole of the channel's markdown right now. */
	note(channel: FadeChannel, segments: readonly string[], now: number): void;
	/** Release whatever `now` says is due. True while frames are still needed. */
	advance(now: number): boolean;
	/** Characters visible for the channel, counting from its first segment. */
	revealed(channel: FadeChannel): number;
	/** Recently released characters, newest first, for tinting. */
	bands(channel: FadeChannel, now?: number): RampBand[];
	/** Where a segment starts in the channel's character stream. */
	segmentStart(channel: FadeChannel, markdown: string): number | undefined;	/** Show everything at once: the message is over and no frame can help. */
	finish(): void;
	/** Forget everything, for a new session. */
	reset(): void;
	/** True while any channel still has characters to release or brighten. */
	readonly animating: boolean;
}

/**
 * The markdown pi renders as one component per channel, in transcript order.
 *
 * Each text block becomes a component of its own, while a run of thinking
 * blocks is joined into one, which is why the two channels join differently.
 * Segments are trimmed because that is the text pi hands to the parser.
 */
export function segmentTexts(message: unknown, channel: FadeChannel): string[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	if (channel === "assistant") {
		return content
			.filter((block): block is { type: string; text: string } => isBlock(block, "text"))
			.map((block) => block.text.trim())
			.filter((text) => text !== "");
	}
	const runs: string[] = [];
	let run: string[] = [];
	for (const block of content) {
		if (isBlock(block, "thinking") && block.thinking.trim() !== "") {
			run.push(block.thinking.trim());
			continue;
		}
		if (run.length > 0) runs.push(run.join("\n\n"));
		run = [];
	}
	if (run.length > 0) runs.push(run.join("\n\n"));
	return runs;
}

function isBlock(block: unknown, type: string): block is { type: string; text: string; thinking: string } {
	const value = block as { type?: unknown; text?: unknown; thinking?: unknown } | undefined;
	if (value?.type !== type) return false;
	const text = type === "thinking" ? value.thinking : value.text;
	return typeof text === "string";
}

/** 0 while barely released, 1 halfway up, 2 once it has settled. */
export function bandLevel(ageMs: number): TintLevel {
	if (ageMs < RAMP_MS / 3) return 0;
	if (ageMs < (2 * RAMP_MS) / 3) return 1;
	return 2;
}

/** Markdown characters that mean the tail is not plain prose. */
const MARKUP = /[`*_[\]|#~>\\]/;
/** Opening code fences in the text so far; odd means we are inside one. */
function insideFence(text: string): boolean {
	const fences = text.match(/```|~~~/g);
	return fences !== null && fences.length % 2 === 1;
}

/**
 * Show the first `budget` characters of `markdown`, with the ones released
 * most recently tinted by `bands` (newest first, as `FadeState.bands` gives).
 *
 * The two are separate on purpose: a budget that reaches the end is still
 * tinted while the ramp runs, so the last characters brighten rather than snap
 * to their final colour. A full budget with no bands returns the markdown
 * untouched, so a settled message is never rewritten.
 */
export function fadeMarkdown(
	markdown: string,
	budget: number,
	bands: readonly RampBand[],
	tint: Tint,
): string {
	const length = markdown.length;
	if (length === 0) return markdown;
	const cut = Math.max(0, Math.min(Math.floor(budget), length));
	if (cut <= 0) return "";
	// Nothing is being tinted and everything has been revealed: the common case
	// of a settled message, which must come back byte for byte.
	if (bands.length === 0 && cut >= length) return markdown;
	const head = markdown.slice(0, cut);
	// Colour needs somewhere safe to land: not inside a fence, and not across
	// markup that is still being typed.
	if (insideFence(head)) return head;
	if (MARKUP.test(head.slice(Math.max(0, cut - RAMP_CHARS)))) return head;

	const edits: { start: number; end: number; level: TintLevel }[] = [];
	let cursor = cut;
	for (const band of bands) {
		if (cursor <= 0) break;
		const take = Math.min(band.chars, cursor);
		const level = bandLevel(band.ageMs);
		if (level < 2) edits.push({ start: cursor - take, end: cursor, level });
		cursor -= take;
	}
	let out = "";
	let at = 0;
	for (const edit of edits.reverse()) {
		out += head.slice(at, edit.start) + tint(edit.level, head.slice(edit.start, edit.end));
		at = edit.end;
	}
	return out + head.slice(at);
}

/**
 * What to hand pi's markdown for the streaming component, right now.
 *
 * This is the whole of what the extension does per render, kept here so the
 * demo harness and the tests drive the same code the TUI does. Text pi never
 * measured comes back untouched rather than guessed at.
 */
export function renderStreaming(fade: FadeState, channel: FadeChannel, markdown: string, now: number, tint: Tint): string {
	const start = fade.segmentStart(channel, markdown);
	if (start === undefined) return markdown;
	return fadeMarkdown(markdown, fade.revealed(channel) - start, fade.bands(channel, now), tint);
}

interface Channel {
	/** The segments pi is rendering for this channel, newest state. */
	segments: string[];
	/** Where each segment starts, in the channel's character stream. */
	starts: number[];
	/** What pi puts between two segments of the same channel. */
	joiner: string;
	/** Every segment concatenated: what the character stream is made of. */
	joined: string;
	/** Characters that have arrived. */
	target: number;
	/** Characters released so far. */
	released: number;
	/** When characters were last released, so slow frames still add up. */
	lastAt: number;
	/** Release batches still inside the colour ramp, oldest first. */
	batches: { at: number; chars: number }[];
	/** Whether anything has been noted for this channel yet. */
	started: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function createFadeState(options: Partial<FadeOptions> = {}): FadeState {
	const windowMs = clamp(options.windowMs ?? DEFAULT_FADE_MS, MIN_FADE_MS, MAX_FADE_MS);
	const rate = clamp(options.rate ?? DEFAULT_FADE_RATE, MIN_FADE_RATE, MAX_FADE_RATE);
	const tailRate = rate / TAIL_FRACTION;
	const channels: Record<FadeChannel, Channel> = {
		assistant: blankChannel(""),
		"assistant-thinking": blankChannel("\n\n"),
	};
	/** The time `bands` ages against when the caller does not pass one. */
	let seenAt = 0;

	function blankChannel(joiner: string): Channel {
		return { segments: [], starts: [], joiner, joined: "", target: 0, released: 0, lastAt: 0, batches: [], started: false };
	}

	/** Release `chars` as one batch, so the ramp can age them together. */
	function release(channel: Channel, chars: number, now: number): void {
		channel.released += chars;
		channel.batches.push({ at: now, chars });
		channel.lastAt = now;
	}

	/**
	 * Drop batches that have settled, or that sit too far back to be tinted.
	 *
	 * A dropped batch is not forgotten: its characters stay counted in
	 * `released`, they are simply finished with.
	 */
	function prune(channel: Channel, now: number): void {
		let excess = channel.batches.reduce((sum, batch) => sum + batch.chars, 0) - RAMP_CHARS;
		while (excess > 0 && channel.batches.length > 0) {
			excess -= channel.batches.shift()!.chars;
		}
		while (channel.batches.length > 0 && now - channel.batches[0].at >= RAMP_MS) {
			channel.batches.shift();
		}
	}

	return {
		get animating() {
			return Object.values(channels).some((channel) => channel.target > channel.released || channel.batches.length > 0);
		},
		note(name, segments, now) {
			const channel = channels[name];
			const joined = segments.join(channel.joiner);
			const starts: number[] = [];
			let offset = 0;
			for (const segment of segments) {
				starts.push(offset);
				offset += segment.length + (starts.length > 1 ? channel.joiner.length : 0);
			}
			// Text that is not an append of what we had is a rewrite: a branch
			// swap or a compaction. Our offsets mean nothing against it, so the
			// whole channel shows at once rather than half-wrong.
			const appended = !channel.started || joined.startsWith(channel.joined);
			channel.segments = [...segments];
			channel.starts = starts;
			channel.joined = joined;
			channel.target = joined.length;
			channel.started = true;
			channel.lastAt = now;
			seenAt = now;
			const arrived = channel.target - channel.released;
			if (!appended || arrived <= 0) {
				if (!appended) {
					channel.released = channel.target;
					channel.batches = [];
				}
				return;
			}
			// A token's worth of text is already smooth; delaying it would be lag,
			// and tinting it would ask for frames on every token of a stream that
			// never needed smoothing in the first place.
			if (arrived <= SMOOTH_THRESHOLD) {
				channel.released = channel.target;
				channel.lastAt = now;
				return;
			}
			// One character now, so a chunk never flashes empty, then the rest
			// at the rate below.
			release(channel, 1, now);
		},
		advance(now) {
			let animating = false;
			for (const channel of Object.values(channels)) {
				const backlog = channel.target - channel.released;
				if (backlog > 0) {
					const since = Math.max(0, now - channel.lastAt);
					const pace = Math.min(rate, Math.max(backlog / (windowMs / 1000), tailRate));
					const extra = Math.min(backlog, Math.floor((pace * since) / 1000));
					if (extra > 0) release(channel, extra, now);
				}
				prune(channel, now);
				animating = animating || channel.target > channel.released || channel.batches.length > 0;
			}
			seenAt = now;
			return animating;
		},
		revealed(name) {
			return channels[name].released;
		},
		bands(name, now = seenAt) {
			return channels[name].batches
				.slice()
				.reverse()
				.map((batch) => ({ chars: batch.chars, ageMs: Math.max(0, now - batch.at) }));
		},
		segmentStart(name, markdown) {
			const channel = channels[name];
			const index = channel.segments.indexOf(markdown);
			return index === -1 ? undefined : channel.starts[index];
		},
		finish() {
			for (const channel of Object.values(channels)) {
				channel.released = channel.target;
				channel.batches = [];
			}
		},
		reset() {
			channels.assistant = blankChannel("");
			channels["assistant-thinking"] = blankChannel("\n\n");
			seenAt = 0;
		},
	};
}
