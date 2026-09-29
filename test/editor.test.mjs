import { test } from "node:test";
import assert from "node:assert/strict";
import { resetCapabilitiesCache, setCapabilityOverrides, visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG, MIN_BOX_WIDTH } from "../lib/config.ts";
import { FaikuEditor } from "../lib/editor.ts";
import { MARKER } from "../lib/history.ts";
import { emptyInfo } from "../lib/info.ts";
import { stripAnsi } from "../lib/palette.ts";

/** The parts of a TUI, an EditorTheme and a KeybindingsManager the box touches. */
function harness(overrides = {}) {
	const notifiers = [];
	const keybindings = {
		matches: (data, action) => (overrides.actions ?? {})[action] === data,
	};
	const editor = new FaikuEditor(
		{ terminal: { rows: overrides.rows ?? 40, columns: 100 }, requestRender: () => {} },
		{ borderColor: (text) => text, selectList: {} },
		keybindings,
		{
			info: () => ({ ...emptyInfo(), ...overrides.info }),
			config: { ...DEFAULT_CONFIG, ...overrides.config },
			notify: (kind, label, detail) => notifiers.push({ kind, label, detail }),
			readClipboard: overrides.readClipboard ?? (async () => "x".repeat(142)),
		},
	);
	editor.focused = true;
	return { editor, notifiers };
}

const full = {
	model: "anthropic/claude-sonnet-4-5",
	provider: "anthropic",
	thinking: "medium",
	contextPercent: 12.4,
	contextTokens: 18_400,
	cost: 0.42,
	cwd: "/Users/adam/code/pi-faiku-theme",
	branch: "feat/theme",
	dirtyChanged: 2,
	elapsedMs: 252_000,
	idle: true,
};

const lines = (editor, width) => editor.render(width).map(stripAnsi);

/** The key sequences the box reacts to, as the terminal sends them. */
const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	home: "\x01",
	enter: "\r",
	tab: "\t",
	escape: "\x1b",
	actions: {
		"tui.editor.cursorUp": "\x1b[A",
		"tui.editor.cursorDown": "\x1b[B",
		"tui.editor.cursorLineStart": "\x01",
		"tui.input.submit": "\r",
		"app.interrupt": "\x1b",
	},
};

/** The rows of the panel: the square box and everything between its rules. */
const panelRows = (editor, width = 60) => {
	const rows = lines(editor, width);
	const top = rows.findIndex((row) => row.startsWith("┌"));
	if (top < 0) return [];
	const bottom = rows.findIndex((row) => row.startsWith("└"));
	return rows.slice(top, bottom + 1);
};

/** The prompts the panel is offering, as they are drawn, top row first. */
const panelEntries = (editor, width = 60) =>
	panelRows(editor, width)
		.slice(1, -1)
		.map((row) => {
			const body = row.slice(1, -1).trim();
			const marked = body.startsWith(MARKER);
			return { text: (marked ? body.slice(MARKER.length) : body).trimEnd(), marked };
		});

test("every row of the box is exactly as wide as the terminal", () => {
	const { editor } = harness({ info: full });
	for (const width of [24, 30, 40, 60, 80, 120, 200]) {
		for (const line of editor.render(width)) {
			assert.equal(visibleWidth(line), width, `row is ${visibleWidth(line)} at width ${width}`);
		}
	}
});

test("the box is a rounded frame with a padded interior", () => {
	const { editor } = harness({ info: full });
	const rows = lines(editor, 60);
	const top = rows.findIndex((row) => row.startsWith("╭"));
	const bottom = rows.findIndex((row) => row.startsWith("╰"));
	assert.ok(top > 0);
	assert.ok(bottom > top);
	// Comfortable padding puts a blank row above and below the text.
	const blank = `│${" ".repeat(58)}│`;
	assert.equal(rows[top + 1], blank);
	assert.equal(rows[bottom - 1], blank);
	const interior = rows[top + 2];
	assert.ok(interior.startsWith("│") && interior.endsWith("│"));
	// Padding: the prompt sits inside the rule, not against it.
	assert.ok(interior.startsWith("│ ❯"));
});

test("the header names the model and the rail names the place", () => {
	const { editor } = harness({ info: full });
	const rows = lines(editor, 80);
	assert.ok(rows[0].includes("🧠 claude-sonnet-4-5"));
	assert.ok(rows[0].includes("🔀 anthropic"));
	assert.ok(rows.at(-1).includes("📁 code/pi-faiku-theme"));
	assert.ok(rows.at(-1).includes("🌿 feat/theme"));
});

test("the placeholder is shown only while the input is empty", () => {
	const { editor } = harness({ info: full });
	const first = () => lines(editor, 80).find((row) => row.includes("❯"));
	assert.ok(first().includes("Ask anything…"));
	editor.setText("hello");
	assert.ok(!first().includes("Ask anything…"));
	assert.ok(first().includes("hello"));
});

test("a custom placeholder is used when one is configured", () => {
	const { editor } = harness({ info: full, config: { placeholder: "Say something" } });
	assert.ok(lines(editor, 80).some((row) => row.includes("Say something")));
});

test("wrapped and multi-line text stays inside the frame", () => {
	const { editor } = harness({ info: full });
	editor.setText("first line\nsecond line\nthird line that is much longer than the others and will have to wrap somewhere");
	const rows = lines(editor, 60);
	const text = rows.filter((row) => row.includes("line") || row.includes("wrap"));
	assert.ok(text.length >= 4);
	for (const row of text) {
		assert.ok(row.startsWith("│"), row);
		assert.ok(row.endsWith("│"), row);
		assert.equal(visibleWidth(row), 60);
	}
	// The first row carries the prompt; the rest are indented to match it.
	assert.ok(text[0].includes("❯"));
	assert.equal(text[1].indexOf("second"), text[0].indexOf("first"));
});

// The opencode amber, as each terminal mode spells it. Both are checked
// because CI has no truecolor, and a test that only knows truecolor is a test
// that only passes on the developer's laptop.
const AMBER = { truecolor: "\x1b[38;2;250;178;131m", "256color": "\x1b[38;5;216m" };

test("the frame turns amber and says so while the agent works", () => {
	const { editor } = harness({ info: { ...full, idle: false } });
	const top = editor.render(80)[1];
	assert.ok(stripAnsi(top).includes("⏳ working"));
	assert.ok(
		top.includes(AMBER.truecolor) || top.includes(AMBER["256color"]),
		`the working frame is painted in the opencode amber, not ${JSON.stringify(top)}`,
	);
});

test("the working frame is amber in truecolor, and stays amber without it", (t) => {
	for (const [trueColor, escape] of [
		[true, AMBER.truecolor],
		[false, AMBER["256color"]],
	]) {
		t.test(`${trueColor ? "truecolor" : "256color"} terminal`, () => {
			setCapabilityOverrides({ trueColor });
			t.after(() => {
				resetCapabilitiesCache();
				setCapabilityOverrides({});
			});
			const { editor } = harness({ info: { ...full, idle: false } });
			const top = editor.render(80)[1];
			assert.ok(top.includes(escape), JSON.stringify(top));
		});
	}
});

test("a terminal too short for padding gets a tight box", () => {
	const roomy = harness({ info: full, rows: 40 });
	const cramped = harness({ info: full, rows: 12 });
	assert.equal(roomy.editor.render(60).length, 7);
	assert.equal(cramped.editor.render(60).length, 5);
});

test("compact padding drops the blank rows at any height", () => {
	const { editor } = harness({ info: full, config: { padding: "compact" } });
	assert.equal(editor.render(60).length, 5);
});

test("the header and the rail can each be switched off", () => {
	const { editor } = harness({ info: full, config: { header: false, hintRail: false } });
	const rows = lines(editor, 80);
	assert.equal(rows.length, 5);
	assert.ok(rows[0].startsWith("╭"));
});

test("below the minimum width pi's own editor is left alone", () => {
	const { editor } = harness({ info: full });
	const width = MIN_BOX_WIDTH - 1;
	const rows = editor.render(width);
	assert.equal(visibleWidth(rows[0]), width);
	assert.ok(!stripAnsi(rows[0]).includes("╭"));
});

test("a paste reports the size that actually arrived", () => {
	const { editor, notifiers } = harness({ info: full });
	const payload = "line one\nline two\n".repeat(40);
	editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
	assert.equal(notifiers.length, 1);
	assert.equal(notifiers[0].kind, "paste");
	assert.equal(notifiers[0].label, "Pasted");
	assert.equal(notifiers[0].detail, `${payload.length} chars`);
	// The base still received the paste: the text is really in the editor.
	assert.ok(editor.getText().length > 0);
});

test("a paste split across several reads is still one paste", () => {
	const { editor, notifiers } = harness({ info: full });
	editor.handleInput("\x1b[200~hello ");
	editor.handleInput("world\x1b[201~");
	assert.equal(notifiers.length, 1);
	assert.equal(notifiers[0].detail, "11 chars");
});

test("an empty paste is reported rather than ignored", () => {
	const { editor, notifiers } = harness({ info: full });
	editor.handleInput("\x1b[200~\x1b[201~");
	assert.equal(notifiers[0].kind, "paste");
	assert.equal(notifiers[0].detail, "empty");
});

test("a clipboard image is its own kind of paste", () => {
	const { editor, notifiers } = harness({ info: full, actions: { "app.clipboard.pasteImage": "\x16" } });
	editor.handleInput("\x16");
	assert.deepEqual(notifiers, [{ kind: "image", label: "Pasted image", detail: undefined }]);
});

test("a copy reports how much was copied", async () => {
	const { editor, notifiers } = harness({ info: full, actions: { "tui.input.copy": "\x03" } });
	editor.handleInput("\x03");
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.deepEqual(notifiers, [{ kind: "copy", label: "Copied", detail: "142 chars" }]);
});

test("a copy still reports when the clipboard cannot be read", async () => {
	const { editor, notifiers } = harness({
		info: full,
		actions: { "tui.input.copy": "\x03" },
		readClipboard: async () => undefined,
	});
	editor.handleInput("\x03");
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.deepEqual(notifiers, [{ kind: "copy", label: "Copied", detail: undefined }]);
});

test("a copy reports even when reading the clipboard fails", async () => {
	const { editor, notifiers } = harness({
		info: full,
		actions: { "tui.input.copy": "\x03" },
		readClipboard: async () => {
			throw new Error("no clipboard here");
		},
	});
	editor.handleInput("\x03");
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(notifiers[0].label, "Copied");
});

test("a disposed editor reports nothing more", async () => {
	const { editor, notifiers } = harness({ info: full, actions: { "tui.input.copy": "\x03" } });
	editor.dispose();
	editor.handleInput("\x1b[200~abc\x1b[201~");
	editor.handleInput("\x03");
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.deepEqual(notifiers, []);
});

test("ordinary typing is not mistaken for a clipboard event", () => {
	const { editor, notifiers } = harness({ info: full });
	editor.handleInput("h");
	editor.handleInput("i");
	assert.equal(editor.getText(), "hi");
	assert.deepEqual(notifiers, []);
});

// The history panel: arrow up opens it, the arrows walk it, enter restores.

/** An editor with prompts already sent, and a record of what was submitted. */
function withHistory(overrides = {}, ...prompts) {
	const sent = [];
	const built = harness({ ...overrides, actions: { ...KEYS.actions, ...overrides.actions } });
	built.editor.onSubmit = (text) => sent.push(text);
	for (const prompt of prompts) built.editor.addToHistory(prompt);
	return { ...built, sent };
}

test("arrow up opens the panel above the box, newest prompt marked", () => {
	const { editor } = withHistory({ info: full }, "add a toast on write", "refactor the parser");
	editor.handleInput(KEYS.up);
	assert.equal(editor.getText(), "refactor the parser");
	assert.deepEqual(
		panelEntries(editor).map((entry) => entry.text),
		["add a toast on write", "refactor the parser"],
	);
	const marked = panelEntries(editor).filter((entry) => entry.marked);
	assert.equal(marked.length, 1);
	assert.equal(marked[0].text, "refactor the parser");
});

test("the panel sits directly above the input box", () => {
	const { editor } = withHistory({ info: full }, "an older prompt", "the newest prompt");
	editor.handleInput(KEYS.up);
	const rows = lines(editor, 60);
	const panel = rows.findIndex((row) => row.startsWith("┌"));
	const box = rows.findIndex((row) => row.startsWith("╭"));
	assert.ok(panel >= 0);
	assert.equal(box, panel + panelRows(editor).length);
	// The highlighted prompt is in the editor as well as in the panel.
	assert.ok(rows[box + 2].includes("the newest prompt"));
});

test("walking up and down moves the marker, not the list", () => {
	const { editor } = withHistory({ info: full }, "oldest", "middle", "newest");
	editor.handleInput(KEYS.up);
	assert.equal(panelEntries(editor).find((entry) => entry.marked).text, "newest");
	editor.handleInput(KEYS.up);
	assert.equal(editor.getText(), "middle");
	assert.equal(panelEntries(editor).find((entry) => entry.marked).text, "middle");
	editor.handleInput(KEYS.up);
	assert.equal(editor.getText(), "oldest");
	// Past the oldest there is nowhere left to go, and the panel says so.
	editor.handleInput(KEYS.up);
	assert.equal(editor.getText(), "oldest");
	assert.equal(panelRows(editor).length, 5);
	editor.handleInput(KEYS.down);
	assert.equal(editor.getText(), "middle");
	assert.equal(panelEntries(editor).find((entry) => entry.marked).text, "middle");
});

test("walking past the newest prompt puts the draft back and closes the panel", () => {
	const { editor } = withHistory({ info: full }, "an older prompt", "the newest prompt");
	editor.handleInput("half a th");
	// Arrow up only walks the history from the top of the input, which is pi's
	// own rule: a half-typed prompt with the cursor at the end moves the cursor.
	editor.handleInput(KEYS.up);
	assert.equal(editor.getText(), "half a th");
	assert.deepEqual(panelRows(editor), []);
	editor.handleInput(KEYS.home);
	editor.handleInput(KEYS.up);
	assert.equal(editor.getText(), "the newest prompt");
	editor.handleInput(KEYS.down);
	assert.equal(editor.getText(), "half a th");
	assert.deepEqual(panelRows(editor), []);
});

test("enter restores the prompt and sends nothing", () => {
	const { editor, sent } = withHistory({ info: full }, "add a toast on write", "refactor the parser");
	editor.handleInput(KEYS.up);
	editor.handleInput(KEYS.up);
	editor.handleInput(KEYS.enter);
	assert.equal(editor.getText(), "add a toast on write");
	assert.deepEqual(sent, []);
	assert.deepEqual(panelRows(editor), []);
	// A second enter is what sends it.
	editor.handleInput(KEYS.enter);
	assert.deepEqual(sent, ["add a toast on write"]);
});

test("escape gives back what was being typed", () => {
	const { editor } = withHistory({ info: full }, "an older prompt");
	editor.handleInput("half a th");
	editor.handleInput(KEYS.home);
	editor.handleInput(KEYS.up);
	assert.equal(editor.getText(), "an older prompt");
	editor.handleInput(KEYS.escape);
	assert.equal(editor.getText(), "half a th");
	assert.deepEqual(panelRows(editor), []);
});

test("typing keeps the highlighted prompt and closes the panel", () => {
	const { editor } = withHistory({ info: full }, "an older prompt");
	editor.handleInput(KEYS.up);
	editor.handleInput("!");
	assert.equal(editor.getText(), "an older prompt!");
	assert.deepEqual(panelRows(editor), []);
});

test("arrow up with nothing sent opens no panel", () => {
	const { editor } = withHistory({ info: full });
	editor.handleInput(KEYS.up);
	assert.deepEqual(panelRows(editor), []);
	assert.equal(editor.getText(), "");
});

test("arrow up inside a multi-line prompt moves the cursor, not the history", () => {
	const { editor } = withHistory({ info: full }, "an older prompt");
	editor.setText("first line\nsecond line");
	editor.handleInput(KEYS.up);
	// The base moved the cursor onto the line above, so there is nothing to show.
	assert.deepEqual(panelRows(editor), []);
	assert.equal(editor.getText(), "first line\nsecond line");
});

test("the panel shows no more rows than it was configured for", () => {
	const { editor } = withHistory({ info: full, config: { historyMaxVisible: 2 } }, "one", "two", "three", "four");
	editor.handleInput(KEYS.up);
	assert.equal(panelRows(editor).length, 4);
	// The window slides so the marker is never off the panel.
	editor.handleInput(KEYS.up);
	assert.equal(panelEntries(editor).length, 2);
	assert.equal(panelEntries(editor).find((entry) => entry.marked).text, "three");
});

test("the panel can be switched off, and the box still walks the history", () => {
	const { editor } = withHistory({ info: full, config: { history: false } }, "an older prompt");
	editor.handleInput(KEYS.up);
	assert.deepEqual(panelRows(editor), []);
	assert.equal(editor.getText(), "an older prompt");
});

test("the hint rail offers the panel only while it is switched on", () => {
	const { editor } = harness({ info: full });
	assert.ok(lines(editor, 100).at(-1).includes("↑ history"));
	const off = harness({ info: full, config: { history: false } });
	assert.ok(!lines(off.editor, 100).at(-1).includes("↑ history"));
});

// The `@` picker: enter on a directory opens it instead of closing the list.

/**
 * pi's own picker, shown over an editor that already has its text.
 *
 * The provider is a stand-in that answers the two questions the box asks and
 * nothing else: what is on the list, and what does accepting a row do to the
 * text. The rules are pi's own — a directory keeps the picker up, a file gets a
 * trailing space and closes it — so the box is exercised against the behaviour
 * it actually inherits rather than against a mock of itself.
 */
function withPicker(text, items, selectedIndex = 0) {
	const built = harness({ info: full });
	const { editor } = built;
	const selected = () => items[selectedIndex];
	editor.setAutocompleteProvider({
		getSuggestions: async () => null,
		shouldTriggerFileCompletion: () => true,
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
			const isDirectory = item.label.endsWith("/");
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol - prefix.length);
			const next = `${before}${item.value}${isDirectory ? "" : " "}`;
			return {
				lines: lines.map((line, index) => (index === cursorLine ? next : line)),
				cursorLine,
				cursorCol: before.length + item.value.length + (isDirectory ? 0 : 1),
			};
		},
	});
	editor.setText(text);
	editor.autocompletePrefix = text;
	editor.autocompleteList = { getSelectedItem: selected };
	editor.autocompleteState = "regular";
	// Opening a directory means asking the base for the list again, which is a
	// call into the provider. The answer is the provider's business, so the ask
	// is what the test counts: reopening is the one thing the box adds.
	editor.reopened = 0;
	editor.forceFileAutocomplete = () => {
		editor.reopened += 1;
		editor.autocompleteState = "force";
		editor.autocompleteList = { getSelectedItem: selected };
		editor.autocompletePrefix = editor.getText();
	};
	return built;
}

const DIRECTORY = { value: "@lib/", label: "lib/" };
const FILE = { value: "@lib/editor.ts", label: "editor.ts" };

test("enter on a directory opens it rather than closing the picker", () => {
	const { editor } = withPicker("@", [DIRECTORY, FILE]);
	editor.handleInput(KEYS.enter);
	assert.equal(editor.getText(), "@lib/");
	assert.equal(editor.reopened, 1);
	assert.equal(editor.isShowingAutocomplete(), true);
});

test("tab opens a directory the same way enter does", () => {
	const { editor } = withPicker("@", [DIRECTORY, FILE]);
	editor.handleInput(KEYS.tab);
	assert.equal(editor.getText(), "@lib/");
	assert.equal(editor.reopened, 1);
	assert.equal(editor.isShowingAutocomplete(), true);
});

test("enter on a file accepts it and closes the picker, as pi does", () => {
	const { editor } = withPicker("@lib/", [FILE], 0);
	editor.handleInput(KEYS.enter);
	assert.equal(editor.getText(), "@lib/editor.ts ");
	assert.equal(editor.reopened, 0);
	assert.equal(editor.isShowingAutocomplete(), false);
});

test("a slash command argument that names a directory is left to pi", () => {
	const { editor } = withPicker("/run lib", [{ value: "/run lib/", label: "lib/" }]);
	editor.handleInput(KEYS.enter);
	assert.equal(editor.reopened, 0);
});

test("an ordinary path completion is left to pi too", () => {
	const { editor } = withPicker("src", [{ value: "src/lib/", label: "lib/" }]);
	editor.handleInput(KEYS.enter);
	assert.equal(editor.reopened, 0);
});

test("enter with no picker up still sends the prompt", () => {
	const { editor } = harness({ info: full });
	const sent = [];
	editor.onSubmit = (text) => sent.push(text);
	editor.setText("@lib/");
	editor.handleInput(KEYS.enter);
	assert.deepEqual(sent, ["@lib/"]);
});
