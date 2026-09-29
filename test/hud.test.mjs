import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { emptyInfo } from "../lib/info.ts";
import { fitSegments, headerSegments, railLeftSegments, railRightSegments, renderHeader, renderHintRail, renderSegments } from "../lib/hud.ts";
import { stripAnsi } from "../lib/palette.ts";

const info = {
	...emptyInfo(),
	model: "anthropic/claude-sonnet-4-5",
	provider: "anthropic",
	thinking: "medium",
	contextPercent: 12.4,
	contextTokens: 18_400,
	tokensIn: 4200,
	tokensOut: 980,
	cost: 0.42,
	cwd: "/Users/adam/code/FaikuTheme",
	branch: "feat/theme",
	dirtyChanged: 2,
	dirtyUntracked: 1,
	elapsedMs: 252_000,
};

const emojiOf = (segments) => segments.map((segment) => segment.emoji ?? "");

test("the header leads with the model, and each fact has its own emoji", () => {
	const segments = headerSegments(info);
	assert.equal(segments[0].text, "claude-sonnet-4-5");
	assert.deepEqual(emojiOf(segments), ["🧠", "🔀", "🔁", "🧮", "🔢", "💲", "⏱"]);
});

test("a fact that is not known is left out, not faked", () => {
	const bare = emptyInfo();
	assert.deepEqual(headerSegments(bare), []);
	assert.deepEqual(railLeftSegments(bare), []);
	// …and a fact that is zero is not a fact either.
	assert.deepEqual(emojiOf(headerSegments({ ...info, elapsedMs: 0 })), ["🧠", "🔀", "🔁", "🧮", "🔢", "💲"]);
});

test("thinking is only worth a segment when it is on", () => {
	assert.equal(headerSegments({ ...info, thinking: "off" }).some((s) => s.text.startsWith("thinking")), false);
	assert.equal(headerSegments({ ...info, thinking: "high" })[2].text, "thinking high");
});

test("the rail shows the location, the branch and the dirty counts", () => {
	const segments = railLeftSegments(info);
	assert.equal(segments[0].text, "code/FaikuTheme");
	assert.equal(segments[1].text, "feat/theme");
	assert.ok(segments[2].text.includes("✚2"));
	assert.ok(segments[2].text.includes("＋1"));
});

test("a clean repository shows no dirty markers at all", () => {
	const clean = railLeftSegments({ ...info, dirtyChanged: 0, dirtyUntracked: 0 });
	assert.equal(clean.some((segment) => segment.text.includes("✚")), false);
});

test("the key hints are the last thing to be dropped", () => {
	assert.deepEqual(emojiOf(railRightSegments()), ["⏎", "⇧⏎", "/", "⌃c", "⌃v"]);
});

test("fitSegments drops the least important fact until the row fits", () => {
	const segments = headerSegments(info);
	assert.equal(fitSegments(segments, 10_000).length, segments.length);
	const narrow = fitSegments(segments, 40);
	assert.equal(narrow[0].text, "claude-sonnet-4-5");
	assert.ok(visibleWidth(renderSegments(narrow, 40)) <= 40);
	// Cost and the timer are the two least important facts.
	assert.equal(narrow.some((segment) => segment.text === "$0.42"), false);
});

test("one segment is kept even when it does not fit, and then clipped", () => {
	const kept = fitSegments(headerSegments(info), 4);
	assert.equal(kept.length, 1);
	assert.equal(visibleWidth(renderSegments(kept, 12)), 12);
});

test("every rendered row is exactly the width it was given", () => {
	for (const width of [24, 30, 40, 60, 80, 120, 200]) {
		assert.equal(visibleWidth(renderHeader(info, width)), width, `header at ${width}`);
		assert.equal(visibleWidth(renderHintRail(info, width)), width, `rail at ${width}`);
	}
});

test("the keys sit hard against the right edge when there is room", () => {
	const rail = stripAnsi(renderHintRail(info, 140));
	assert.ok(rail.trimEnd().endsWith("⌃v paste"));
	// …and the facts against the left.
	assert.ok(rail.startsWith("📁 code/FaikuTheme"));
});

test("a hint gives way to a fact before the facts start going", () => {
	// At 80 columns the least important hints are dropped, and everything worth
	// knowing about where you are survives.
	const rail = stripAnsi(renderHintRail(info, 80));
	assert.ok(rail.startsWith("📁 code/FaikuTheme"));
	assert.ok(rail.includes("🌿 feat/theme"));
	assert.ok(rail.includes("✚2"));
	assert.ok(rail.includes("⏱ 4m12s"));
	assert.ok(rail.includes("⏎ send"));
	assert.ok(!rail.includes("⌃v paste"));
});

test("a narrow terminal keeps the facts and drops the hints", () => {
	const rail = stripAnsi(renderHintRail(info, 46));
	assert.ok(!rail.includes("send"));
	assert.ok(rail.startsWith("📁 code/FaikuTheme"));
	assert.ok(rail.includes("🌿 feat/theme"));
});

test("an unknown width leaves an empty row rather than a broken one", () => {
	assert.equal(renderSegments([], 40), "");
	assert.equal(renderSegments(headerSegments(info), 0), "");
	assert.equal(renderHintRail(emptyInfo(), 0).length, 0);
});
