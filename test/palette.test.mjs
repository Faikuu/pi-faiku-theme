import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { FAIKU_PALETTE, hexTo256, painter, paint, stripAnsi } from "../lib/palette.ts";

const theme = JSON.parse(await readFile(new URL("../themes/faiku.json", import.meta.url), "utf8"));

test("the theme is named for the file it ships in", () => {
	assert.equal(theme.name, "faiku");
});

test("every hex in the theme is one the palette knows about", () => {
	const known = new Set(Object.values(FAIKU_PALETTE));
	const seen = new Set();
	const walk = (node) => {
		if (typeof node === "string") {
			if (node.startsWith("#")) seen.add(node.toLowerCase());
			return;
		}
		if (node && typeof node === "object") for (const value of Object.values(node)) walk(value);
	};
	walk(theme.colors);
	walk(theme.export);
	for (const hex of seen) assert.ok(known.has(hex), `${hex} is not in the Faiku palette`);
});

test("the theme's shared variables are the opencode palette, by role", () => {
	assert.equal(theme.vars.amber, FAIKU_PALETTE.primary);
	assert.equal(theme.vars.blue, FAIKU_PALETTE.secondary);
	assert.equal(theme.vars.purple, FAIKU_PALETTE.accent);
	assert.equal(theme.vars.green, FAIKU_PALETTE.green);
	assert.equal(theme.vars.red, FAIKU_PALETTE.red);
	assert.equal(theme.vars.orange, FAIKU_PALETTE.orange);
	assert.equal(theme.vars.cyan, FAIKU_PALETTE.cyan);
	assert.equal(theme.vars.yellow, FAIKU_PALETTE.yellow);
	assert.equal(theme.vars.text, FAIKU_PALETTE.foreground);
	assert.equal(theme.vars.muted, FAIKU_PALETTE.muted);
	assert.equal(theme.vars.border, FAIKU_PALETTE.border);
	assert.equal(theme.vars.line, FAIKU_PALETTE.selection);
	assert.equal(theme.vars.panel, FAIKU_PALETTE.panel);
	assert.equal(theme.vars.darker, FAIKU_PALETTE.darker);
});

test("the roles pi requires are all present, and resolve through vars or hex", () => {
	const required = [
		"accent",
		"border",
		"borderAccent",
		"borderMuted",
		"success",
		"error",
		"warning",
		"muted",
		"dim",
		"text",
		"thinkingText",
		"selectedBg",
		"userMessageBg",
		"userMessageText",
		"customMessageBg",
		"customMessageText",
		"customMessageLabel",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
		"toolTitle",
		"toolOutput",
	];
	for (const role of required) {
		assert.ok(role in theme.colors, `missing role ${role}`);
		const value = theme.colors[role];
		const resolves = typeof value === "string" && (value.startsWith("#") || value in theme.vars);
		assert.ok(resolves, `${role} = ${value} resolves to nothing`);
	}
});

test("the accent roles are the opencode amber and blue", () => {
	assert.equal(theme.colors.accent, "amber");
	assert.equal(theme.colors.borderAccent, "amber");
	assert.equal(theme.colors.border, "border");
	assert.equal(theme.colors.mdLink, "amber");
	assert.equal(theme.colors.mdHeading, "blue");
});

test("hexTo256 lands on the cube for saturated colors and the ramp for neutrals", () => {
	// Pure red is a cube entry, and a near-black neutral is a gray ramp entry.
	assert.equal(hexTo256("#ff0000"), 196);
	assert.ok(hexTo256("#212121") >= 232);
	// Pure black is a tie between cube black and the ramp, and either is correct.
	const black = hexTo256("#000000");
	assert.ok(black === 16 || black >= 232);
	assert.throws(() => hexTo256("#fff"), /Invalid hex color/);
	assert.throws(() => hexTo256("nonsense"), /Invalid hex color/);
});

test("painting wraps in a color and closes without resetting the style", () => {
	const painted = paint("primary", "hi");
	assert.equal(stripAnsi(painted), "hi");
	assert.match(painted, /\x1b\[(38;2;250;178;131|38;5;\d+)m/);
	// Closing with 39 keeps an enclosing bold or dim intact.
	assert.ok(painted.endsWith("\x1b[39m"));
});

test("the same color always paints the same way", () => {
	assert.equal(painter("#fab283")("a"), painter("#fab283")("a"));
});

test("stripAnsi removes SGR, OSC and the cursor marker DCS", () => {
	assert.equal(stripAnsi("\x1b[1mbold\x1b[22m"), "bold");
	assert.equal(stripAnsi("\x1b]0;title\x07text"), "text");
	assert.equal(stripAnsi("\x1b_pi:c\x07text"), "text");
	assert.equal(stripAnsi("plain"), "plain");
});
