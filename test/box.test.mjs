import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { bottomBorder, fit, GLYPHS, joinParts, sideRow, sideRowParts, topBorder } from "../lib/box.ts";

test("fit pads and truncates to exactly the width given", () => {
	assert.equal(visibleWidth(fit("abc", 6)), 6);
	assert.equal(fit("abc", 6), "abc   ");
	assert.equal(fit("abcdef", 3), "abc");
	assert.equal(fit("abc", 0), "");
	// Emoji count as two columns, so the padding has to be measured, not counted.
	assert.equal(visibleWidth(fit("🧠 model", 20)), 20);
});

test("a plain border is corners and fill, exactly the width", () => {
	assert.equal(joinParts(topBorder(10)), "╭────────╮");
	assert.equal(joinParts(bottomBorder(10)), "╰────────╯");
	assert.equal(visibleWidth(joinParts(topBorder(80))), 80);
});

test("a label sits inside the fill, one column in from the corner", () => {
	const parts = topBorder(20, "⏳ working");
	assert.equal(joinParts(parts), "╭─ ⏳ working ─────╮");
	assert.equal(visibleWidth(joinParts(parts)), 20);
	assert.equal(parts.find((part) => part.kind === "label").text, " ⏳ working ");
});

test("a label that cannot fit is dropped rather than truncated mid-word", () => {
	const narrow = joinParts(topBorder(12, "a very long status message"));
	assert.equal(narrow, "╭──────────╮");
	assert.ok(!narrow.includes("a very"));
});

test("degenerate widths do not produce negative repeats", () => {
	assert.deepEqual(topBorder(0), []);
	assert.equal(joinParts(topBorder(1)), "╭");
	assert.equal(sideRow("x", 1), "│");
	assert.equal(sideRow("x", 0), "");
	assert.equal(joinParts(bottomBorder(2)), "╰╯");
});

test("sideRow frames content to the exact width", () => {
	assert.equal(sideRow("hi", 6), "│hi  │");
	assert.equal(sideRow("hi", 6).length, 6);
	assert.equal(visibleWidth(sideRow("🧠 hi", 12)), 12);
	assert.equal(sideRow("too wide for this box", 8), "│too wi│");
});

test("sideRowParts splits the row so the caller can color the rules", () => {
	const parts = sideRowParts("hi", 6);
	assert.equal(parts.left.text, "│");
	assert.equal(parts.right.text, "│");
	assert.equal(parts.interior, "hi");
	assert.equal(parts.fill, "  ");
	assert.equal(parts.innerWidth, 4);
});

test("the square glyph set is available for notifications", () => {
	assert.equal(joinParts(topBorder(4, undefined, GLYPHS.square)), "┌──┐");
	assert.equal(joinParts(bottomBorder(4, undefined, GLYPHS.square)), "└──┘");
	assert.equal(sideRow("ab", 4, GLYPHS.square), "│ab│");
});
