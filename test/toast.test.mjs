import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { stripAnsi } from "../lib/palette.ts";
import { createToastStore, renderToasts, TOAST_EMOJI } from "../lib/toast.ts";

test("a toast names its own event with the matching emoji", () => {
	assert.equal(TOAST_EMOJI.copy, "📋");
	assert.equal(TOAST_EMOJI.paste, "📥");
	assert.equal(TOAST_EMOJI.image, "🖼️");
	assert.equal(TOAST_EMOJI.warning, "⚠️");
	assert.equal(TOAST_EMOJI.error, "❌");
});

test("the newest toast is first", () => {
	const store = createToastStore();
	store.push("copy", "Copied", "142 chars");
	store.push("paste", "Pasted", "1 284 chars");
	assert.deepEqual(
		store.items().map((toast) => toast.label),
		["Pasted", "Copied"],
	);
	assert.equal(store.has(), true);
});

test("a toast disappears once its time is up", () => {
	let now = 1000;
	const store = createToastStore({ ttlMs: 500, now: () => now });
	store.push("copy", "Copied", "142 chars");
	assert.equal(store.tick(now + 499), false);
	assert.equal(store.items().length, 1);
	assert.equal(store.tick(now + 500), true);
	assert.deepEqual(store.items(), []);
	assert.equal(store.has(), false);
});

test("only the last few toasts are on screen at once", () => {
	const store = createToastStore({ max: 2 });
	store.push("copy", "One");
	store.push("paste", "Two");
	store.push("info", "Three");
	assert.deepEqual(
		store.items().map((toast) => toast.label),
		["Three", "Two"],
	);
});

test("one event seen twice is one toast", () => {
	let now = 1000;
	const store = createToastStore({ now: () => now });
	store.push("copy", "Copied", "142 chars");
	now += 10;
	store.push("copy", "Copied", "142 chars");
	assert.equal(store.items().length, 1);
	now += 1000;
	store.push("copy", "Copied", "999 chars");
	assert.equal(store.items().length, 2);
});

test("a toast is a three-line box, exactly as wide as it was given", () => {
	const store = createToastStore();
	store.push("copy", "Copied", "142 chars");
	const lines = renderToasts(store.items(), 30);
	assert.equal(lines.length, 3);
	assert.equal(visibleWidth(lines[0]), 30);
	assert.ok(stripAnsi(lines[0]).startsWith("┌"));
	assert.ok(stripAnsi(lines[1]).includes("📋  Copied"));
	assert.ok(stripAnsi(lines[1]).includes("142 chars"));
	assert.ok(stripAnsi(lines[1]).trimEnd().endsWith("│"));
	assert.ok(stripAnsi(lines[2]).startsWith("└"));
});

test("a toast without a size still renders", () => {
	const store = createToastStore();
	store.push("image", "Pasted image");
	const body = stripAnsi(renderToasts(store.items(), 24)[1]);
	assert.ok(body.includes("🖼️"));
	assert.ok(body.includes("Pasted image"));
});

test("several toasts stack downward, newest on top", () => {
	const store = createToastStore();
	store.push("paste", "Pasted", "10 chars");
	store.push("copy", "Copied", "20 chars");
	const lines = renderToasts(store.items(), 30);
	assert.equal(lines.length, 6);
	assert.ok(stripAnsi(lines[1]).includes("Copied"));
	assert.ok(stripAnsi(lines[4]).includes("Pasted"));
});

test("no toasts, or no room for them, means no rows", () => {
	assert.deepEqual(renderToasts([], 30), []);
	const store = createToastStore();
	store.push("copy", "Copied", "142 chars");
	assert.deepEqual(renderToasts(store.items(), 8), []);
	assert.deepEqual(renderToasts(store.items(), 0), []);
});

test("a size too long for the box loses the label, not the box", () => {
	const store = createToastStore();
	store.push("paste", "Pasted", "123 456 789 012 345 chars");
	const lines = renderToasts(store.items(), 24);
	assert.equal(visibleWidth(lines[1]), 24);
	assert.ok(stripAnsi(lines[1]).includes("Pasted"));
});
