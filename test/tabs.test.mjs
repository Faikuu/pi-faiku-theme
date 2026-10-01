import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { paint, stripAnsi } from "../lib/palette.ts";
import {
	BUSY_MARK,
	buildTabs,
	createTabStore,
	describeTabs,
	formatAge,
	MIN_BAR_WIDTH,
	NEW_CHAT_LABEL,
	describeTabKeys,
	renderTabs,
	resolveTabKeys,
	tabAt,
	tabLabel,
	tabSlotAction,
} from "../lib/tabs.ts";

/** A session a minute newer than the one before it, unless overridden. */
function session(path, overrides = {}) {
	return { path, messageCount: 3, modified: 1_000, ...overrides };
}

/** The bar with its escape codes off, so a test can read it. */
function plain(bar) {
	return bar.lines.map(stripAnsi).join("\n");
}

test("a tab is named by the session, then by what was first said", () => {
	assert.equal(tabLabel(session("/a", { name: "api cleanup" })), "api cleanup");
	assert.equal(tabLabel(session("/a", { firstMessage: "  why is\n the box short?  " })), "why is the box short?");
	assert.equal(tabLabel(session("/a")), "untitled");
	assert.equal(tabLabel(session("/a", { name: "   " }), 10), "untitled");
});

test("a long label is clipped rather than wrapped", () => {
	const label = tabLabel(session("/a", { firstMessage: "a".repeat(80) }));
	assert.equal(visibleWidth(label), 24);
	assert.ok(stripAnsi(label).endsWith("…"));
});

test("the bar is ordered by recency, newest first", () => {
	const tabs = buildTabs([
		session("/old", { modified: 10 }),
		session("/new", { modified: 30 }),
		session("/mid", { modified: 20 }),
	]);
	assert.deepEqual(
		tabs.map((tab) => tab.path),
		["/new", "/mid", "/old"],
	);
	assert.deepEqual(
		tabs.map((tab) => tab.position),
		[1, 2, 3],
	);
});

test("the bar never grows past its cap", () => {
	const sessions = Array.from({ length: 12 }, (_, index) => session(`/s${index}`, { modified: index }));
	const tabs = buildTabs(sessions, { max: 3 });
	assert.equal(tabs.length, 3);
	assert.deepEqual(
		tabs.map((tab) => tab.path),
		["/s11", "/s10", "/s9"],
	);
});

test("a closed session is gone from the bar", () => {
	const tabs = buildTabs([session("/a", { modified: 2 }), session("/b", { modified: 1 })], { closed: ["/a"] });
	assert.deepEqual(
		tabs.map((tab) => tab.path),
		["/b"],
	);
});

test("the session you are in stays on the bar even when it is old", () => {
	const sessions = [session("/new", { modified: 30 }), session("/mid", { modified: 20 }), session("/ancient", { modified: 1 })];
	const tabs = buildTabs(sessions, { currentPath: "/ancient", max: 2 });
	assert.deepEqual(
		tabs.map((tab) => tab.path),
		["/new", "/ancient"],
	);
	assert.equal(tabs[1].current, true);
});

test("only the session you are in can be busy", () => {
	const tabs = buildTabs([session("/a", { modified: 2 }), session("/b", { modified: 1 })], { currentPath: "/a", busy: true });
	assert.equal(tabs[0].busy, true);
	assert.equal(tabs[1].busy, false);
	assert.ok(plain(renderTabs(tabs, 60)).includes(BUSY_MARK));
});

test("the bar is two rows, each exactly as wide as it was asked to be", () => {
	const tabs = buildTabs([session("/a", { firstMessage: "refactor parser" })], { currentPath: "/a" });
	for (const width of [MIN_BAR_WIDTH, 60, 120]) {
		const bar = renderTabs(tabs, width);
		assert.equal(bar.lines.length, 2);
		assert.equal(visibleWidth(bar.lines[0]), width);
		assert.equal(visibleWidth(bar.lines[1]), width);
	}
});

test("a rule under the bar separates it from the transcript", () => {
	const tabs = buildTabs([session("/a", { firstMessage: "alpha" })], { currentPath: "/a" });
	const bar = renderTabs(tabs, 60);
	// One unbroken rule, in the same colour as the input box's frame.
	assert.equal(stripAnsi(bar.lines[1]), "─".repeat(60));
	assert.equal(bar.lines[1], paint("border", "─".repeat(60)));
	// The rule is not a target: it has no regions of its own.
	assert.ok(bar.regions.every((region) => region.end <= 60));
});

test("below the minimum width the bar would be noise, so it draws nothing", () => {
	const tabs = buildTabs([session("/a")]);
	const bar = renderTabs(tabs, MIN_BAR_WIDTH - 1);
	assert.deepEqual(bar.lines, []);
	assert.deepEqual(bar.regions, []);
});

test("the active tab is marked and the row ends with a rule", () => {
	const tabs = buildTabs([session("/a", { firstMessage: "refactor parser" }), session("/b", { firstMessage: "api cleanup" })], {
		currentPath: "/b",
	});
	const bar = renderTabs(tabs, 60);
	const row = stripAnsi(bar.lines[0]);
	assert.match(row, /refactor parser │ ❯ api cleanup/);
	assert.match(row, new RegExp(`\\${NEW_CHAT_LABEL} ─+$`));
	// The rule under it is its own line, so the bar and the transcript do not
	// read as one thing.
	assert.equal(stripAnsi(bar.lines[1]), "─".repeat(60));
});

test("clicking a column picks the tab drawn there", () => {
	const tabs = buildTabs([session("/a", { firstMessage: "alpha" }), session("/b", { firstMessage: "beta" })], { currentPath: "/a" });
	const bar = renderTabs(tabs, 60);
	const regions = bar.regions.filter((region) => region.kind === "tab");
	assert.equal(regions.length, 2);
	assert.equal(tabAt(bar.regions, regions[0].start)?.index, 0);
	assert.equal(tabAt(bar.regions, regions[1].end - 1)?.index, 1);
	// The separator between two tabs belongs to neither.
	assert.equal(tabAt(bar.regions, regions[0].end), undefined);
	// The trailing rule is not a tab either.
	assert.equal(tabAt(bar.regions, 59), undefined);
});

test("the trailing plus is its own target", () => {
	const tabs = buildTabs([session("/a")], { currentPath: "/a" });
	const bar = renderTabs(tabs, 60);
	const plus = bar.regions.find((region) => region.kind === "new");
	assert.ok(plus);
	assert.equal(tabAt(bar.regions, plus.start)?.kind, "new");
	assert.equal(tabAt(bar.regions, plus.start)?.index, -1);
});

test("a preview that cannot start a chat leaves the plus out", () => {
	const tabs = buildTabs([session("/a", { firstMessage: "alpha" })], { currentPath: "/a" });
	assert.ok(!plain(renderTabs(tabs, 60, { newChat: false })).includes(NEW_CHAT_LABEL));
});

test("a narrow terminal drops tabs from the right", () => {
	const tabs = buildTabs(
		Array.from({ length: 8 }, (_, index) => session(`/s${index}`, { firstMessage: `chat number ${index}`, modified: index })),
		{ currentPath: "/s7" },
	);
	const bar = renderTabs(tabs, 60);
	assert.ok(bar.shown.length < 8);
	assert.ok(bar.shown.every((tab) => tab.position <= bar.shown.length + 1));
	// Whatever survived, the row still fits and the active tab is in it.
	assert.equal(visibleWidth(bar.lines[0]), 60);
	assert.equal(bar.shown.some((tab) => tab.current), true);
});

test("the active tab is drawn even when the cut would have dropped it", () => {
	const sessions = Array.from({ length: 8 }, (_, index) => session(`/s${index}`, { firstMessage: `chat number ${index}`, modified: index }));
	const tabs = buildTabs(sessions, { currentPath: "/s0" });
	const bar = renderTabs(tabs, 60);
	const drawn = bar.shown.map((tab) => tab.path);
	assert.ok(!drawn.includes("/s1"), "the newest tabs should have taken the space");
	assert.ok(drawn.includes("/s0"), "the session in view must still be on the bar");
	assert.equal(bar.shown[bar.shown.length - 1].path, "/s0");
});

test("regions stay true to the row after a resize", () => {
	const tabs = buildTabs([session("/a", { firstMessage: "alpha" }), session("/b", { firstMessage: "beta" })], { currentPath: "/a" });
	const bar = renderTabs(tabs, 60);
	const second = bar.regions.filter((region) => region.kind === "tab")[1];
	assert.equal(stripAnsi(bar.lines[0]).slice(second.start, second.end).trim(), "beta");
});

test("an age reads as a chat a person would describe it", () => {
	const now = 1_000_000 * 60 * 60 * 24;
	assert.equal(formatAge(now - 10_000, now), "just now");
	assert.equal(formatAge(now - 14 * 60_000, now), "14m ago");
	assert.equal(formatAge(now - 3 * 3_600_000, now), "3h ago");
	assert.equal(formatAge(now - 2 * 86_400_000, now), "2d ago");
});

test("the listing says where each chat stands", () => {
	const now = 10_000_000;
	const tabs = buildTabs([session("/a", { firstMessage: "alpha", messageCount: 1, modified: now - 3 * 3_600_000 })], {
		currentPath: "/a",
		busy: true,
	});
	const text = describeTabs(tabs, now);
	assert.match(text, /1\. ❯ alpha/);
	assert.match(text, /1 message/);
	assert.match(text, /3h ago/);
	assert.match(text, new RegExp(BUSY_MARK));
	assert.equal(describeTabs([], now), "No chats to show yet.");
});

test("the store loads once and then trusts the cache", async () => {
	let now = 1000;
	let loads = 0;
	const store = createTabStore({
		load: async () => {
			loads++;
			return [session("/a", { firstMessage: loads === 1 ? "alpha" : "beta", modified: now })];
		},
		currentPath: () => "/a",
		ttlMs: 500,
		now: () => now,
	});

	assert.deepEqual(store.tabs(), []);
	assert.equal(await store.refresh(), true, "the first load changes the bar");
	assert.equal(loads, 1);
	assert.equal(store.tabs()[0].label, "alpha");

	assert.equal(await store.refresh(), false);
	assert.equal(loads, 1, "a fresh cache is not reloaded");

	now += 600;
	assert.equal(await store.refresh(), true, "a stale cache is reloaded, and this time it changed");
	assert.equal(loads, 2);
	assert.equal(store.tabs()[0].label, "beta");
});

test("a forced reload ignores the cache", async () => {
	let loads = 0;
	const store = createTabStore({
		load: async () => {
			loads++;
			return [session("/a")];
		},
		currentPath: () => "/a",
	});
	await store.refresh();
	await store.refresh({ force: true });
	assert.equal(loads, 2);
});

test("a session directory that cannot be read leaves the bar alone", async () => {
	let now = 0;
	const store = createTabStore({
		load: async () => {
			throw new Error("EACCES");
		},
		currentPath: () => "/a",
		now: () => now,
	});
	assert.equal(await store.refresh(), false);
	assert.deepEqual(store.tabs(), []);
	now = 60_000;
	assert.equal(await store.refresh(), false, "a failed load is not cached as fresh");
});

test("closing a session hides it until it is reopened", async () => {
	const store = createTabStore({
		load: async () => [session("/a", { modified: 2 }), session("/b", { modified: 1 })],
		currentPath: () => "/a",
	});
	await store.refresh();
	assert.equal(store.close("/b"), true);
	assert.equal(store.close("/b"), false, "closing twice is not a second close");
	assert.deepEqual(
		store.tabs().map((tab) => tab.path),
		["/a"],
	);
	assert.deepEqual(store.closed(), ["/b"]);
	assert.equal(store.reopen(), "/b");
	assert.deepEqual(
		store.tabs().map((tab) => tab.path),
		["/a", "/b"],
	);
	assert.equal(store.reopen(), undefined);
});

test("the store follows the settings it is handed", async () => {
	const store = createTabStore({
		load: async () => [session("/a", { modified: 2 }), session("/b", { modified: 1 })],
		currentPath: () => "/a",
		closed: ["/b"],
	});
	await store.refresh();
	assert.deepEqual(
		store.tabs().map((tab) => tab.path),
		["/a"],
	);
	store.setClosed([]);
	store.setMax(1);
	assert.equal(store.tabs().length, 1);
});
test("the tab keys are the defaults until the user says otherwise", () => {
	const defaults = resolveTabKeys();
	assert.equal(defaults.length, 12);
	assert.deepEqual(
		defaults.map((binding) => binding.key),
		["alt+1", "alt+2", "alt+3", "alt+4", "alt+5", "alt+6", "alt+7", "alt+8", "alt+9", "alt+0", "alt+shift+left", "alt+shift+right"],
	);
	// Position first, then the three verbs: the order is what the help reads as.
	assert.deepEqual(
		defaults.map((binding) => binding.slot),
		["1", "2", "3", "4", "5", "6", "7", "8", "9", "new", "prev", "next"],
	);
});

test("a rebound slot replaces one key and leaves the rest alone", () => {
	const bindings = resolveTabKeys({ "1": "ctrl+alt+1", new: "alt+n" });
	assert.equal(bindings.find((binding) => binding.slot === "1").key, "ctrl+alt+1");
	assert.equal(bindings.find((binding) => binding.slot === "new").key, "alt+n");
	assert.equal(bindings.find((binding) => binding.slot === "2").key, "alt+2");
	assert.equal(bindings.length, 12);
});

test("an empty key unbinds its slot rather than falling back", () => {
	const bindings = resolveTabKeys({ "1": "", prev: "" });
	assert.equal(bindings.some((binding) => binding.slot === "1"), false);
	assert.equal(bindings.some((binding) => binding.slot === "prev"), false);
	assert.equal(bindings.length, 10);
	// A slot nobody mentioned is never invented from a stray setting key.
	assert.equal(bindings.some((binding) => binding.slot === "sideways"), false);
});

test("each key is named with what it does", () => {
	assert.equal(describeTabKeys(resolveTabKeys()).split("\n")[0], "1  alt+1  chat 1");
	assert.match(describeTabKeys(resolveTabKeys({ new: "alt+n" })), /new {2}alt\+n {2}new chat/);
	assert.equal(describeTabKeys([]), "no tab shortcuts are bound");
	assert.equal(tabSlotAction("3"), "chat 3");
	assert.equal(tabSlotAction("nope"), undefined);
});
