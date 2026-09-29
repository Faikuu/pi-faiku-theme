import { test } from "node:test";
import assert from "node:assert/strict";

import { readBorderLabel, readScrollLabel, readVisibleLineCount, splitEditorLines } from "../lib/frame.ts";

const BORDER = "─".repeat(40);

test("splitEditorLines uses the base's own text-line count when it has one", () => {
	const raw = [BORDER, "one", "two", BORDER, "  suggestion"];
	const frame = splitEditorLines(raw, 2);
	assert.equal(frame.top, BORDER);
	assert.deepEqual(frame.content, ["one", "two"]);
	assert.equal(frame.bottom, BORDER);
	assert.deepEqual(frame.extra, ["  suggestion"]);
});

test("a scroll border is recognized by shape when the count is missing", () => {
	const scrolled = "──────── ↑ 3 more ─────────";
	const raw = [scrolled, "one", "two", "────── ↓ 7 more ──────", "  suggestion"];
	const frame = splitEditorLines(raw);
	assert.equal(frame.content.length, 2);
	assert.equal(frame.bottom.includes("↓ 7 more"), true);
	assert.deepEqual(frame.extra, ["  suggestion"]);
});

test("a line of nothing but rules is not mistaken for a bottom border", () => {
	const raw = [BORDER, "────────", "text", BORDER];
	const frame = splitEditorLines(raw);
	assert.deepEqual(frame.content, ["────────", "text"]);
	assert.equal(frame.bottom, BORDER);
});

test("output with no bottom border at all degrades to all content", () => {
	const raw = [BORDER, "only text"];
	const frame = splitEditorLines(raw);
	assert.equal(frame.bottom, "");
	assert.deepEqual(frame.content, ["only text"]);
	assert.deepEqual(frame.extra, []);
});

test("an impossible count is ignored rather than trusted", () => {
	const raw = [BORDER, "one", BORDER];
	const frame = splitEditorLines(raw, 99);
	assert.deepEqual(frame.content, ["one"]);
});

test("readVisibleLineCount only trusts a number", () => {
	assert.equal(readVisibleLineCount({ renderedVisibleLineCount: 3 }), 3);
	assert.equal(readVisibleLineCount({ renderedVisibleLineCount: -1 }), undefined);
	assert.equal(readVisibleLineCount({ renderedVisibleLineCount: "3" }), undefined);
	assert.equal(readVisibleLineCount({}), undefined);
});

test("the scroll label is read out of the base's border", () => {
	assert.equal(readScrollLabel("──── ↑ 3 more ────", "↑"), "↑ 3 more");
	assert.equal(readScrollLabel("──── ↓ 12 more ────", "↓"), "↓ 12 more");
	assert.equal(readScrollLabel("────────────────────", "↑"), undefined);
	assert.equal(readScrollLabel("──── ↑ 3 more ────", "↓"), undefined);
});

test("pi's own status is read out of the base's border", () => {
	assert.equal(readBorderLabel("── ⠋ Thinking… ─────────"), "⠋ Thinking…");
	assert.equal(readBorderLabel("──── ↑ 3 more ────"), undefined);
	assert.equal(readBorderLabel("────────────────────"), undefined);
	assert.equal(readBorderLabel(""), undefined);
	// The status wins over the scroll hint, which is a separate label.
	assert.equal(readBorderLabel("── ⠋ Working… ── ↑ 2 more ──"), "⠋ Working…");
});
