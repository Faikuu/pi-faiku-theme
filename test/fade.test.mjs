import { test } from "node:test";
import assert from "node:assert/strict";

import {
	bandLevel,
	createFadeState,
	fadeMarkdown,
	FRAME_MS,
	segmentTexts,
} from "../lib/fade.ts";

/** A tint that records what it was asked to colour, level 0 dimmest to 2 plain. */
function recordingTint() {
	const calls = [];
	const tint = (level, text) => {
		calls.push({ level, text });
		return level === 2 ? text : `<${level}>${text}</${level}>`;
	};
	return { tint, calls };
}

function message(...content) {
	return { content };
}

test("assistant text becomes one segment per block, trimmed", () => {
	const segments = segmentTexts(
		message({ type: "text", text: "  hello  " }, { type: "text", text: "   " }, { type: "text", text: "world\n" }),
		"assistant",
	);
	assert.deepEqual(segments, ["hello", "world"]);
});

test("thinking runs are joined the way pi joins them", () => {
	const segments = segmentTexts(
		message(
			{ type: "thinking", thinking: "one" },
			{ type: "thinking", thinking: "two" },
			{ type: "text", text: "between" },
			{ type: "thinking", thinking: "three" },
		),
		"assistant-thinking",
	);
	assert.deepEqual(segments, ["one\n\ntwo", "three"]);
});

test("a message with no content of that kind has no segments", () => {
	assert.deepEqual(segmentTexts(undefined, "assistant"), []);
	assert.deepEqual(segmentTexts(message({ type: "toolCall" }), "assistant"), []);
	assert.deepEqual(segmentTexts(message({ type: "text", text: "" }), "assistant-thinking"), []);
});

test("a chunk is smoothed from its first character and never runs ahead of the text", () => {
	const fade = createFadeState({ rate: 600 });
	fade.note("assistant", ["x".repeat(600)], 0);
	const first = fade.revealed("assistant");
	assert.ok(first > 0, "the chunk must not flash empty");
	assert.ok(first < 600);

	let at = 0;
	for (let i = 0; i < 200 && fade.advance((at += FRAME_MS)); i += 1) {
		assert.ok(fade.revealed("assistant") <= 600, "reveal ran past the text");
	}
	assert.equal(fade.revealed("assistant"), 600);
});

test("the reveal drains at the rate ceiling, not instantly", () => {
	const fade = createFadeState({ rate: 600 });
	fade.note("assistant", ["y".repeat(3000)], 0);
	fade.advance(FRAME_MS);
	fade.advance(FRAME_MS * 2);
	// Three frames at 600 chars a second cannot have finished three thousand.
	assert.ok(fade.revealed("assistant") < 120, `revealed ${fade.revealed("assistant")}`);
});

test("a token's worth of text is not delayed", () => {
	const fade = createFadeState({ rate: 600 });
	fade.note("assistant", ["z".repeat(8)], 0);
	assert.equal(fade.revealed("assistant"), 8, "normal streaming must not gain lag");
	assert.equal(fade.animating, false, "and must not ask for frames either");
});

test("a channel keeps its own reveal", () => {
	const fade = createFadeState({ rate: 600 });
	fade.note("assistant", ["a".repeat(100)], 0);
	fade.note("assistant-thinking", ["b".repeat(400)], 0);
	assert.ok(fade.revealed("assistant") < 100);
	assert.ok(fade.revealed("assistant-thinking") < 400);
	fade.advance(FRAME_MS * 50);
	assert.equal(fade.revealed("assistant"), 100);
	assert.equal(fade.revealed("assistant-thinking"), 400);
});

test("frames are only needed while text is pending or still brightening", () => {
	const fade = createFadeState({ rate: 600 });
	assert.equal(fade.animating, false);
	fade.note("assistant", ["q".repeat(50)], 0);
	assert.equal(fade.animating, true);
	let guard = 0;
	while (fade.advance((guard += FRAME_MS)) && guard < 5_000);
	assert.equal(fade.revealed("assistant"), 50);
	assert.equal(fade.animating, false, "still asking for frames after the last char settled");
});

test("text that shrinks or is replaced starts over rather than drifting", () => {
	const fade = createFadeState({ rate: 600 });
	fade.note("assistant", ["m".repeat(400)], 0);
	fade.advance(FRAME_MS * 4);
	const before = fade.revealed("assistant");
	fade.note("assistant", ["m".repeat(10)], FRAME_MS * 5);
	assert.equal(fade.revealed("assistant"), 10);
	assert.ok(fade.revealed("assistant") <= 10);
	assert.ok(before > 0);
});

test("finish shows everything at once and stops the animation", () => {
	const fade = createFadeState({ rate: 600 });
	fade.note("assistant", ["f".repeat(300)], 0);
	fade.finish();
	assert.equal(fade.revealed("assistant"), 300);
	assert.equal(fade.animating, false);
});

test("reset forgets the session's reveals", () => {
	const fade = createFadeState({ rate: 600 });
	fade.note("assistant", ["f".repeat(300)], 0);
	fade.reset();
	assert.equal(fade.revealed("assistant"), 0);
	assert.equal(fade.segmentStart("assistant", "f".repeat(300)), undefined);
});

test("segments are located by their text, so offsets line up across blocks", () => {
	const fade = createFadeState({ rate: 600 });
	fade.note("assistant", ["hello", "there"], 0);
	assert.equal(fade.segmentStart("assistant", "hello"), 0);
	assert.equal(fade.segmentStart("assistant", "there"), 5);
	assert.equal(fade.segmentStart("assistant", "nowhere"), undefined);
});

test("a budget of zero shows nothing and a full budget shows the text untouched", () => {
	const { tint } = recordingTint();
	assert.equal(fadeMarkdown("hello", 0, [], tint), "");
	assert.equal(fadeMarkdown("hello", 99, [], tint), "hello");
});

test("a partial budget is an exact prefix", () => {
	const { tint } = recordingTint();
	assert.equal(fadeMarkdown("hello there", 5, [], tint), "hello");
});

test("the newest characters are the dim ones and settled ones are left alone", () => {
	const { tint, calls } = recordingTint();
	const out = fadeMarkdown("abcdef", 6, [{ chars: 2, ageMs: 0 }, { chars: 4, ageMs: 500 }], tint);
	assert.equal(out, "abcd<0>ef</0>");
	assert.deepEqual(calls.map((call) => call.level), [0]);
});

test("bands age from newest to settled", () => {
	assert.equal(bandLevel(0), 0);
	assert.equal(bandLevel(100), 1);
	assert.equal(bandLevel(5_000), 2);
});

test("a settled tail is never recoloured, however many bands are stale", () => {
	const { tint, calls } = recordingTint();
	assert.equal(fadeMarkdown("abcdef", 6, [{ chars: 6, ageMs: 9_999 }], tint), "abcdef");
	assert.equal(calls.length, 0);
});

test("an open code fence swallows the colour but keeps the reveal", () => {
	const { tint, calls } = recordingTint();
	// A fence the model has not closed yet: the tail is code, and the syntax
	// highlighter must not be handed escape sequences.
	const markdown = "here is code\n```ts\nconst a = 1;";
	const out = fadeMarkdown(markdown, markdown.length, [{ chars: 4, ageMs: 0 }], tint);
	assert.equal(out, markdown, "text inside a fence must come through clean");
	assert.equal(calls.length, 0);
});

test("half-typed markdown is left for the parser to deal with", () => {
	const { tint, calls } = recordingTint();
	const markdown = "the answer is **bol";
	fadeMarkdown(markdown, markdown.length, [{ chars: 3, ageMs: 0 }], tint);
	assert.equal(calls.length, 0);
});

test("plain prose at the head does get coloured", () => {
	const { tint, calls } = recordingTint();
	const markdown = "and then we know it";
	fadeMarkdown(markdown, markdown.length, [{ chars: 2, ageMs: 0 }], tint);
	assert.deepEqual(calls, [{ level: 0, text: "it" }]);
});

test("the bands a channel hands out age from newest to settled", () => {
	const fade = createFadeState({ rate: 600 });
	fade.note("assistant", ["x".repeat(400)], 0);
	fade.advance(FRAME_MS);
	const bands = fade.bands("assistant");
	assert.ok(bands.length >= 2, `expected several batches, got ${bands.length}`);
	assert.equal(bands[0].ageMs, 0);
	assert.ok(bands[0].chars >= bands[bands.length - 1].chars, "newest batch first");

	// Only the tint window survives; the rest of the reveal has settled on
	// screen even though those characters were released a moment ago.
	fade.advance(FRAME_MS * 4);
	const tinted = fade.bands("assistant").reduce((sum, band) => sum + band.chars, 0);
	assert.ok(tinted < fade.revealed("assistant"), `tinted ${tinted} of ${fade.revealed("assistant")}`);
});

test("a state with nothing to show still answers every question", () => {
	const fade = createFadeState();
	assert.equal(fade.revealed("assistant"), 0);
	assert.deepEqual(fade.bands("assistant"), []);
	assert.equal(fade.advance(10_000), false);
	assert.equal(fade.note("assistant", [], 0), undefined);
});

test("the tail of a chunk lands promptly instead of crawling", () => {
	// Sixty characters against a long window would otherwise be paced at the
	// window's own rate, forty a second, and crawl out over a second and a half.
	const fade = createFadeState({ windowMs: 1500, rate: 600 });
	fade.note("assistant", ["t".repeat(60)], 0);
	let at = 0;
	while (fade.advance((at += FRAME_MS)) && at < 5000);
	assert.equal(fade.revealed("assistant"), 60);
	assert.ok(at < 1500, `sixty characters took ${at}ms, longer than the window itself`);
});

test("the window decides how long a chunk takes", () => {
	// Two hundred characters at a rate well above them: the window is what
	// spreads them out, and the reveal is still running halfway through it.
	const fade = createFadeState({ windowMs: 1000, rate: 1200 });
	fade.note("assistant", ["u".repeat(200)], 0);
	let at = 0;
	while (fade.advance((at += FRAME_MS)) && at < 500);
	const halfway = fade.revealed("assistant");
	assert.ok(halfway > 40 && halfway < 160, `${halfway} characters after ${at}ms`);
	while (fade.advance((at += FRAME_MS)) && at < 5000);
	assert.equal(fade.revealed("assistant"), 200);
	assert.ok(at < 2200, `a two hundred character chunk took ${at}ms`);
});

// The contract with pi's own renderer: what this module hands back is parsed by
// pi's markdown, so the escape codes have to survive it — and must never reach
// the inside of a code block, which pi highlights rather than styles.
const PLAIN_THEME = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

test("pi's markdown renders the tinted text at the width it was handed", async () => {
	const { Markdown, visibleWidth } = await import("@earendil-works/pi-tui");
	const { tint } = recordingTint();
	const prose = "the reveal works because pi asks a markdown transformer what to render every time it draws it";
	const shown = fadeMarkdown(prose, 40, [{ chars: 6, ageMs: 0 }], tint);
	for (const line of new Markdown(shown, 1, 0, PLAIN_THEME).render(40)) {
		assert.equal(visibleWidth(line), 40, `line is ${visibleWidth(line)} columns: ${JSON.stringify(line)}`);
	}
});

test("a fenced block reaches pi's highlighter with no escape codes in it", async () => {
	const { Markdown } = await import("@earendil-works/pi-tui");
	const { tint, calls } = recordingTint();
	const code = "here is the patch\n\n```ts\nconst a = 1;\nconst b =";
	const shown = fadeMarkdown(code, code.length, [{ chars: 5, ageMs: 0 }], tint);
	assert.equal(calls.length, 0, "nothing inside a fence may be tinted");
	const lines = new Markdown(shown, 1, 0, PLAIN_THEME).render(40);
	assert.ok(lines.some((line) => line.includes("const a = 1;")), "the code itself still renders");
});
