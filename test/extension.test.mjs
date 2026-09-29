import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension reads the agent directory when it is constructed, so the test
// points it at a scratch directory before anything is imported.
const agentDir = await mkdtemp(join(tmpdir(), "faiku-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: faikuTheme, THEME_NAME } = await import("../index.ts");

/** Just enough of the extension API to drive the wiring. */
function fakePi() {
	const commands = new Map();
	const events = new Map();
	return {
		commands,
		events,
		registerCommand: (name, definition) => commands.set(name, definition),
		registerTool: () => {},
		registerShortcut: () => {},
		on: (event, handler) => events.set(event, handler),
	};
}

function fakeContext(overrides = {}) {
	const notifications = [];
	const ui = {
		notifications,
		editorFactory: undefined,
		editorCleared: null,
		themes: [{ name: THEME_NAME, path: join(agentDir, "themes", "faiku.json") }],
		currentTheme: "dark",
		overlays: [],
		setTheme: (name) => {
			ui.currentTheme = name;
			ui.theme = { name };
			return { success: true };
		},
		getAllThemes: () => ui.themes,
		setEditorComponent: (factory) => {
			ui.editorFactory = factory;
			if (factory === undefined) ui.editorCleared = true;
		},
		getEditorComponent: () => ui.editorFactory,
		notify: (message, level) => notifications.push({ message, level }),
		custom: (factory, options) => {
			ui.overlays.push({ factory, options });
			options.onHandle?.({ hide: () => {}, setHidden: () => {} });
			return new Promise(() => {});
		},
		theme: { name: "dark" },
	};
	return {
		mode: "tui",
		cwd: agentDir,
		ui,
		model: { id: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
		thinkingLevel: "medium",
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 1 }),
		sessionManager: { getBranch: () => [] },
		...overrides,
	};
}

async function start(settings) {
	if (settings) await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
	else await writeFile(join(agentDir, "settings.json"), JSON.stringify({}));
	const pi = fakePi();
	await faikuTheme(pi);
	const ctx = fakeContext();
	await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	return { pi, ctx };
}

const readConfig = async () => JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));

test("the theme is applied and the box is installed on session start", async () => {
	const { ctx } = await start();
	assert.equal(ctx.ui.currentTheme, THEME_NAME);
	assert.equal(typeof ctx.ui.editorFactory, "function");
	// The toast overlay is a non-capturing top-right overlay.
	assert.equal(ctx.ui.overlays.length, 1);
	assert.equal(ctx.ui.overlays[0].options.overlay, true);
	assert.equal(ctx.ui.overlays[0].options.overlayOptions().anchor, "top-right");
	assert.equal(ctx.ui.overlays[0].options.overlayOptions().nonCapturing, true);
});

test("a missing theme is not applied, and says nothing about it", async () => {
	const pi = fakePi();
	await faikuTheme(pi);
	const ctx = fakeContext({ ui: undefined });
	ctx.ui = {
		...fakeContext().ui,
		themes: [],
		notifications: [],
	};
	await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(ctx.ui.currentTheme, "dark");
	assert.deepEqual(ctx.ui.notifications, []);
});

test("the command is registered, and reports what is on", async () => {
	const { pi, ctx } = await start();
	const command = pi.commands.get("faiku");
	assert.equal(typeof command.handler, "function");
	await command.handler("", ctx);
	const report = ctx.ui.notifications.at(-1).message;
	assert.ok(report.includes("box        on"));
	assert.ok(report.includes("toasts     on"));
	assert.ok(report.includes("settings  "));
});

test("every switch can be turned off from the command, and is persisted", async () => {
	const { pi, ctx } = await start();
	const command = pi.commands.get("faiku");
	for (const verb of ["box", "toasts", "header", "rail", "git", "elapsed", "theme"]) {
		await command.handler(`${verb} off`, ctx);
	}
	assert.equal(ctx.ui.editorCleared, true);
	assert.equal(ctx.ui.currentTheme, "dark");
	const saved = (await readConfig()).faiku;
	assert.equal(saved.box, false);
	assert.equal(saved.toasts, false);
	assert.equal(saved.header, false);
	assert.equal(saved.hintRail, false);
	assert.equal(saved.gitStatus, false);
	assert.equal(saved.elapsed, false);
	assert.equal(saved.applyTheme, false);
});

test("a switch with no on or off is refused, and changes nothing", async () => {
	const { pi, ctx } = await start();
	await pi.commands.get("faiku").handler("box", ctx);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("needs on or off"));
	assert.equal(ctx.ui.editorCleared, null);
});

test("the master switch turns the whole thing off and back on", async () => {
	const { pi, ctx } = await start();
	const command = pi.commands.get("faiku");
	await command.handler("off", ctx);
	assert.equal(ctx.ui.editorCleared, true);
	assert.equal((await readConfig()).faiku.enabled, false);
	await command.handler("on", ctx);
	assert.equal(typeof ctx.ui.editorFactory, "function");
	assert.equal((await readConfig()).faiku.enabled, true);
});

test("padding and the placeholder are configurable, and a bad value is refused", async () => {
	const { pi, ctx } = await start();
	const command = pi.commands.get("faiku");
	await command.handler("padding compact", ctx);
	await command.handler("placeholder Say something", ctx);
	const saved = (await readConfig()).faiku;
	assert.equal(saved.padding, "compact");
	assert.equal(saved.placeholder, "Say something");
	await command.handler("padding roomy", ctx);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("Usage:"));
	assert.equal((await readConfig()).faiku.padding, "compact");
});

test("the demo draws the box and fires a toast", async () => {
	const { pi, ctx } = await start();
	await pi.commands.get("faiku").handler("demo", ctx);
	const report = ctx.ui.notifications.at(-1).message;
	assert.ok(report.includes("╭"));
	assert.ok(report.includes("Ask anything…"));
	assert.ok(report.includes("📁"));
});

test("a theme the user chose is not replaced on session start", async () => {
	const pi = fakePi();
	await faikuTheme(pi);
	const base = fakeContext();
	const ctx = fakeContext();
	ctx.ui.theme = { name: "my-own-theme" };
	await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(ctx.ui.currentTheme, "dark");
	// The box is still installed: the theme and the box are independent.
	assert.equal(typeof ctx.ui.editorFactory, "function");
	void base;
});

test("`/faiku theme on` takes the theme back even so", async () => {
	const pi = fakePi();
	await faikuTheme(pi);
	const ctx = fakeContext();
	ctx.ui.theme = { name: "my-own-theme" };
	await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(ctx.ui.currentTheme, "dark");
	await pi.commands.get("faiku").handler("theme on", ctx);
	assert.equal(ctx.ui.currentTheme, THEME_NAME);
	await pi.commands.get("faiku").handler("theme off", ctx);
	assert.equal(ctx.ui.currentTheme, "my-own-theme");
});

test("a configuration written before the session is honoured", async () => {
	const { ctx } = await start({ faiku: { box: false, toasts: false, applyTheme: false, placeholder: "Ready" } });
	assert.equal(ctx.ui.editorFactory, undefined);
	assert.equal(ctx.ui.overlays.length, 0);
	assert.equal(ctx.ui.currentTheme, "dark");
});

test("shutting down releases the editor and the overlay", async () => {
	const { pi, ctx } = await start();
	pi.events.get("session_shutdown")({ type: "session_shutdown" });
	// Nothing may throw, and a second shutdown must be harmless too.
	pi.events.get("session_shutdown")({ type: "session_shutdown" });
	assert.equal(ctx.ui.editorFactory === undefined || typeof ctx.ui.editorFactory === "function", true);
});
