import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG, MIN_BOX_WIDTH } from "../lib/config.ts";
import { FaikuEditor } from "../lib/editor.ts";
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

test("the frame turns amber and says so while the agent works", () => {
	const { editor } = harness({ info: { ...full, idle: false } });
	const top = editor.render(80)[1];
	assert.ok(stripAnsi(top).includes("⏳ working"));
	assert.match(top, /\x1b\[38;2;250;178;131m/, "the working frame is painted in the opencode amber");
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
