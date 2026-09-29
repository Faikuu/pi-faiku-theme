import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	createHistoryStore,
	historyWindow,
	renderHistory,
	shortenPrompt,
} from "../lib/history.ts";
import { stripAnsi } from "../lib/palette.ts";

test("the newest prompt is first, the way arrow up walks", () => {
	const store = createHistoryStore();
	store.add("first prompt");
	store.add("second prompt");
	assert.deepEqual([...store.entries()], ["second prompt", "first prompt"]);
	assert.equal(store.size(), 2);
	assert.equal(store.has(), true);
});

test("a prompt is recorded the way the base records it", () => {
	const store = createHistoryStore();
	store.add("   ");
	store.add("");
	assert.equal(store.has(), false);
	// Trimmed, so what the panel lists is what the base put back in the editor.
	store.add("  padded  ");
	assert.deepEqual([...store.entries()], ["padded"]);
	// The same prompt twice in a row is one prompt.
	store.add("padded");
	assert.equal(store.size(), 1);
	// But the same prompt again later is worth another row.
	store.add("something else");
	store.add("padded");
	assert.deepEqual([...store.entries()], ["padded", "something else", "padded"]);
});

test("only the last hundred prompts are kept, like pi's own history", () => {
	const store = createHistoryStore();
	for (let index = 0; index < 120; index++) store.add(`prompt ${index}`);
	assert.equal(store.size(), 100);
	assert.equal(store.entries()[0], "prompt 119");
	assert.equal(store.entries().at(-1), "prompt 20");
});

test("where a prompt sits in the list is answerable", () => {
	const store = createHistoryStore();
	store.add("older");
	store.add("newer");
	assert.equal(store.indexOf("newer"), 0);
	assert.equal(store.indexOf("older"), 1);
	assert.equal(store.indexOf("never sent"), -1);
});

test("a prompt is shortened to one row, with the line breaks collapsed", () => {
	assert.equal(shortenPrompt("  refactor   the\tparser\ninto lib  ", 40), "refactor the parser into lib");
	assert.equal(shortenPrompt("short", 0), "");
});

test("a prompt too long for the row ends in an ellipsis, not a hard cut", () => {
	const short = stripAnsi(shortenPrompt("refactor the parser into lib/parse.ts", 20));
	assert.equal(visibleWidth(short), 20);
	assert.ok(short.endsWith("…"), short);
	assert.ok(short.startsWith("refactor the pars"), short);
});

test("a window holds the selection and no more than it was asked for", () => {
	assert.deepEqual(historyWindow(0, 0, 6), { start: 0, end: 0 });
	// Fewer prompts than rows: everything fits.
	assert.deepEqual(historyWindow(3, 0, 6), { start: 0, end: 3 });
	// The newest prompt is selected, so the window is the newest prompts.
	assert.deepEqual(historyWindow(10, 0, 4), { start: 0, end: 4 });
	// Walking back moves the window down one entry at a time.
	assert.deepEqual(historyWindow(10, 1, 4), { start: 0, end: 4 });
	assert.deepEqual(historyWindow(10, 3, 4), { start: 0, end: 4 });
	assert.deepEqual(historyWindow(10, 4, 4), { start: 1, end: 5 });
	// The oldest prompt is still inside the window at the end of the list.
	assert.deepEqual(historyWindow(10, 9, 4), { start: 6, end: 10 });
	// A nonsense selection cannot push the window off the list.
	assert.deepEqual(historyWindow(4, 99, 3), { start: 1, end: 4 });
	assert.deepEqual(historyWindow(4, -1, 3), { start: 0, end: 3 });
});

// Panels are drawn from a real store, so "newest first" is not a convention
// these tests have to remember: adding in order leaves the last one on top.
function prompts(...texts) {
	const store = createHistoryStore();
	for (const text of texts) store.add(text);
	return [...store.entries()];
}

const panel = (entries, selected, width = 44, maxVisible) => renderHistory(entries, selected, width, maxVisible).map(stripAnsi);

test("the panel is a square box, because the input box is a rounded one", () => {
	const rows = panel(prompts("older prompt", "newest prompt"), 0);
	assert.ok(rows[0].startsWith("┌") && rows[0].endsWith("┐"));
	assert.ok(rows[0].includes("history"));
	assert.ok(rows.at(-1).startsWith("└") && rows.at(-1).endsWith("┘"));
	assert.ok(!rows.some((row) => row.includes("╭")));
});

test("every row of the panel is exactly as wide as it was given", () => {
	for (const width of [20, 24, 40, 60, 120]) {
		for (const row of renderHistory(["a prompt", "another prompt", "a third one"], 1, width)) {
			assert.equal(visibleWidth(row), width, `row is ${visibleWidth(row)} at width ${width}`);
		}
	}
});

test("the newest prompt sits at the bottom, next to the input", () => {
	const rows = panel(prompts("older", "newer", "newest"), 0);
	const body = rows.slice(1, -1);
	assert.equal(body.length, 3);
	assert.ok(body[0].includes("older"), body[0]);
	assert.ok(body.at(-1).includes("newest"), body.at(-1));
});

test("the marker is on the entry that will be restored", () => {
	const rows = panel(prompts("older", "newer", "newest"), 1);
	const marked = rows.filter((row) => row.includes("❯"));
	assert.equal(marked.length, 1);
	assert.ok(marked[0].includes("newer"), marked[0]);
});

test("the panel says how to confirm and how to give up", () => {
	assert.ok(panel(prompts("a prompt"), 0, 60).at(-1).includes("restore"));
	// Too narrow for the hint: the rule stays a rule.
	assert.ok(!panel(prompts("a prompt"), 0, 24).at(-1).includes("restore"));
});

test("the panel only shows as many rows as it was given", () => {
	const store = createHistoryStore();
	for (let index = 0; index < 20; index++) store.add(`prompt ${index}`);
	// prompt 19 was added last, so it is the newest and the one selected.
	const rows = panel([...store.entries()], 0, 44, 3);
	// Three prompts between the two rules.
	assert.equal(rows.length, 5);
	assert.ok(rows[1].includes("prompt 17"), rows[1]);
	assert.ok(rows[3].includes("prompt 19"), rows[3]);
});

test("no panel without history, and none too narrow to read", () => {
	assert.deepEqual(renderHistory([], 0, 60), []);
	assert.deepEqual(renderHistory(["a prompt"], 0, 12), []);
});
