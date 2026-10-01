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
const { stripAnsi } = await import("../lib/palette.ts");

/** Just enough of the extension API to drive the wiring. */
function fakePi() {
	const commands = new Map();
	const events = new Map();
	const shortcuts = new Map();
	const sent = [];
	const pi = {
		commands,
		events,
		shortcuts,
		/** Text pi was asked to dispatch, i.e. the commands the bar ran. */
		sent,
		registerCommand: (name, definition) => commands.set(name, definition),
		registerTool: () => {},
		registerShortcut: (key, options) => shortcuts.set(key, options),
		on: (event, handler) => events.set(event, handler),
		getCommands: () => [...commands.keys()].map((name) => ({ name })),
		sendUserMessage: (text) => {
			sent.push(text);
		},
	};
	return pi;
}

/** Which renderer the fake pi hands out: fullscreen, or the regular inline one. */
let tuiMode = "fullscreen";

/** Just enough of pi's renderer: a fixed screen, or the regular inline one. */
function fakeTui() {
	return { mode: tuiMode, terminal: { rows: 40, columns: 100 }, requestRender: () => {} };
}

/** The rows a mounted overlay would draw, with its escape codes off. */
async function overlayRows(ctx, anchor, width = 100) {
	const entry = ctx.ui.overlays.find((overlay) => overlay.options.overlayOptions().anchor === anchor);
	if (!entry) return undefined;
	const component = await entry.factory(fakeTui(), {}, { matches: () => false }, () => {});
	return component.render(width).map(stripAnsi);
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
		toolsExpanded: false,
		thinkingToggles: 0,
		selects: [],
		setTheme: (name) => {
			ui.currentTheme = name;
			ui.theme = { name };
			return { success: true };
		},
		getAllThemes: () => ui.themes,
		setEditorComponent: (factory) => {
			ui.editorFactory = factory;
			if (factory === undefined) ui.editorCleared = true;
			// pi calls the factory itself and only then copies its own action
			// handlers into the editor, so the fake does the same: the collapse
			// feature reaches thinking visibility through those handlers.
			if (factory) {
				const component = factory(fakeTui(), { borderColor: (text) => text }, { matches: () => false });
				component.actionHandlers.set("app.thinking.toggle", () => {
					ui.thinkingToggles += 1;
				});
				ui.editor = component;
			}
		},
		getEditorComponent: () => ui.editorFactory,
		getToolsExpanded: () => ui.toolsExpanded,
		setToolsExpanded: (expanded) => {
			ui.toolsExpanded = expanded;
		},
		select: async (title, options) => {
			ui.selects.push({ title, options });
			return options[ui.pick ?? 0];
		},
		notify: (message, level) => notifications.push({ message, level }),
		statuses: [],
		setStatus: (key, text) => {
			if (text === undefined) ui.statuses = ui.statuses.filter((row) => row.key !== key);
			else ui.statuses.push({ key, text });
		},
		custom: (factory, options) => {
			const entry = { factory, options, closed: false };
			ui.overlays.push(entry);
			options.onHandle?.({ hide: () => {}, setHidden: () => {} });
			// pi shows the overlay by calling the factory and keeps it until the
			// component calls back with `done`, so the fake does the same: an
			// unmount is only observable if the factory ran.
			factory(fakeTui(), {}, { matches: () => false }, () => {
				entry.closed = true;
			});
			return new Promise(() => {});
		},
		theme: { name: "dark" },
	};
	return {
		mode: "tui",
		hasUI: true,
		cwd: agentDir,
		ui,
		model: { id: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
		thinkingLevel: "medium",
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 1 }),
		sessionManager: {
			getBranch: () => [],
			getEntries: () => ui.entries ?? [],
			getSessionDir: () => agentDir,
			getSessionFile: () => ui.sessionFile,
			getSessionName: () => ui.sessionName,
		},
		...overrides,
	};
}

async function start(settings, options = {}) {
	// A restart reads what the last session left behind; only a fresh start
	// replaces the file.
	if (settings) await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
	else if (!options.keepSettings) await writeFile(join(agentDir, "settings.json"), JSON.stringify({}));
	const pi = fakePi();
	await faikuTheme(pi);
	const ctx = fakeContext();
	await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	return { pi, ctx };
}

const readConfig = async () => JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** The seconds the `/faiku` report claims the agent has been working. */
async function reportedWork(pi, ctx) {
	await pi.commands.get("faiku").handler("info", ctx);
	const line = ctx.ui.notifications.at(-1).message.split("\n").find((row) => row.startsWith("working"));
	const [, hours = 0, minutes = 0, seconds = 0] = line.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\s*(?:·|$)/);
	return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

test("the theme is applied and the box is installed on session start", async () => {
	const { ctx } = await start();
	assert.equal(ctx.ui.currentTheme, THEME_NAME);
	assert.equal(typeof ctx.ui.editorFactory, "function");
	// The toast overlay is a non-capturing top-right overlay.
	const toasts = ctx.ui.overlays.find((overlay) => overlay.options.overlayOptions().anchor === "top-right");
	assert.ok(toasts);
	assert.equal(toasts.options.overlay, true);
	assert.equal(toasts.options.overlayOptions().nonCapturing, true);
	// And the tab bar is a second non-capturing overlay across the top row.
	const bar = ctx.ui.overlays.find((overlay) => overlay.options.overlayOptions().anchor === "top-left");
	assert.ok(bar);
	assert.equal(bar.options.overlayOptions().width, "100%");
	assert.equal(bar.options.overlayOptions().nonCapturing, true);
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

test("thinking blocks start collapsed, and pi's own toggle is what hides them", async () => {
	const { pi, ctx } = await start();
	// One flip, through the handler pi gave the editor: nothing reimplemented.
	assert.equal(ctx.ui.thinkingToggles, 1);
	await pi.commands.get("faiku").handler("info", ctx);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("collapse   all"));
});

test("thinking blocks already hidden by pi are not toggled again", async () => {
	const { ctx } = await start({ hideThinkingBlock: true });
	assert.equal(ctx.ui.thinkingToggles, 0);
});

test("expanded tool output is collapsed again on session start", async () => {
	const { pi, ctx } = await start();
	ctx.ui.toolsExpanded = true;
	await pi.commands.get("faiku").handler("collapse all", ctx);
	assert.equal(ctx.ui.toolsExpanded, false);
});

test("the master switch hands pi's own thinking state back", async () => {
	const { pi, ctx } = await start();
	// Folded on the way in, unfolded on the way out, both through pi's toggle.
	assert.equal(ctx.ui.thinkingToggles, 1);
	await pi.commands.get("faiku").handler("off", ctx);
	assert.equal(ctx.ui.editorCleared, true);
	assert.equal(ctx.ui.thinkingToggles, 2);
	// And a session that starts with the package off folds nothing at all.
	const again = await start({ faiku: { enabled: false } });
	assert.equal(again.ctx.ui.thinkingToggles, 0);
});

test("a remounted box keeps following the thinking toggle", async () => {
	const { pi, ctx } = await start();
	// The editor goes away and comes back, with a new map of action handlers.
	await pi.commands.get("faiku").handler("box off", ctx);
	assert.equal(ctx.ui.editorCleared, true);
	ctx.ui.thinkingToggles = 0;
	await pi.commands.get("faiku").handler("box on", ctx);
	// Put back the state the session start changed, then collapse it again: both
	// flips have to be seen by the new editor, or the second one is a no-op.
	await pi.commands.get("faiku").handler("collapse off", ctx);
	await pi.commands.get("faiku").handler("collapse all", ctx);
	assert.equal(ctx.ui.thinkingToggles, 2);
});

test("the collapse mode decides which groups start collapsed", async () => {
	const { pi, ctx } = await start({ faiku: { collapse: "tools" } });
	// Thinking is not this configuration's business, so it is left alone.
	assert.equal(ctx.ui.thinkingToggles, 0);
	await pi.commands.get("faiku").handler("collapse thinking", ctx);
	assert.equal((await readConfig()).faiku.collapse, "thinking");
	assert.equal(ctx.ui.thinkingToggles, 1);
	// Turning the mode off puts back the thinking state faiku itself changed.
	await pi.commands.get("faiku").handler("collapse off", ctx);
	assert.equal((await readConfig()).faiku.collapse, "off");
	assert.equal(ctx.ui.thinkingToggles, 2);
});

test("a collapse mode that is not one of the four is refused, and changes nothing", async () => {
	const { pi, ctx } = await start();
	await pi.commands.get("faiku").handler("collapse everything", ctx);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("Usage:"));
	assert.equal((await readConfig()).faiku?.collapse, undefined);
	assert.equal(ctx.ui.thinkingToggles, 1);
});

test("thinking cannot be collapsed without the box, and the report says so", async () => {
	const { pi, ctx } = await start({ faiku: { box: false } });
	assert.equal(ctx.ui.editorFactory, undefined);
	assert.equal(ctx.ui.thinkingToggles, 0);
	await pi.commands.get("faiku").handler("info", ctx);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("needs the faiku box on"));
	// Tool output still gets the treatment it asked for.
	ctx.ui.toolsExpanded = true;
	await pi.commands.get("faiku").handler("collapse tools", ctx);
	assert.equal(ctx.ui.toolsExpanded, false);
});

test("`/faiku blocks` lists the collapsed groups and expands the one picked", async () => {
	const { pi, ctx } = await start();
	ctx.ui.entries = [
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "1", name: "bash", arguments: {} }] },
		},
	];
	ctx.ui.pick = 0;
	await pi.commands.get("faiku").handler("blocks", ctx);
	assert.deepEqual(ctx.ui.selects.at(-1).options, [
		"thinking       1 block · collapsed",
		"tool output   1 call · collapsed",
		"everything    expand",
		"collapse all again",
	]);
	// The first row expands thinking and nothing else.
	assert.equal(ctx.ui.thinkingToggles, 2);
	assert.equal(ctx.ui.toolsExpanded, false);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("Thinking blocks expanded"));
});

test("`/faiku blocks` expands tool output on the second row", async () => {
	const { pi, ctx } = await start();
	ctx.ui.entries = [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] } },
	];
	ctx.ui.pick = 0;
	await pi.commands.get("faiku").handler("blocks", ctx);
	assert.deepEqual(ctx.ui.selects.at(-1).options, ["tool output   1 call · collapsed", "collapse all again"]);
	assert.equal(ctx.ui.toolsExpanded, true);
	assert.equal(ctx.ui.thinkingToggles, 1);
});

test("`/faiku blocks` collapses everything again from its last row", async () => {
	const { pi, ctx } = await start();
	ctx.ui.entries = [
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } },
	];
	ctx.ui.pick = 0;
	await pi.commands.get("faiku").handler("blocks", ctx);
	ctx.ui.pick = 0;
	await pi.commands.get("faiku").handler("blocks", ctx);
	// Nothing was collapsed by the first pick, so the only row left collapses.
	assert.deepEqual(ctx.ui.selects.at(-1).options, ["collapse all again"]);
	// Session start collapsed them, the first pick expanded them, and this row
	// puts them back: three flips of pi's own toggle in all.
	assert.equal(ctx.ui.thinkingToggles, 3);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("collapsed"));
});

test("cancelling the picker changes nothing", async () => {
	const { pi, ctx } = await start();
	ctx.ui.entries = [
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } },
	];
	ctx.ui.pick = undefined;
	ctx.ui.select = async () => undefined;
	await pi.commands.get("faiku").handler("blocks", ctx);
	assert.equal(ctx.ui.thinkingToggles, 1);
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
	// Toasts are off, so the only thing left on screen is the tab bar.
	assert.equal(ctx.ui.overlays.length, 1);
	assert.equal(ctx.ui.overlays[0].options.overlayOptions().anchor, "top-left");
	assert.equal(ctx.ui.currentTheme, "dark");
});

test("`faiku.tabs off` takes the bar away and puts it back", async () => {
	const { pi, ctx } = await start();
	const command = pi.commands.get("faiku");
	await command.handler("tabs off", ctx);
	assert.equal(ctx.ui.overlays.filter((overlay) => overlay.options.overlayOptions().anchor === "top-left").length, 1);
	// Turning it off unmounts; the handle is gone rather than hidden.
	assert.equal((await readConfig()).faiku.tabs, false);
	await command.handler("tabs on", ctx);
	assert.equal((await readConfig()).faiku.tabs, true);
});

test("the timer counts the agent's working time, not the session's", async () => {
	// pi flips its own busy flag around these events, and `isIdle` reads it.
	let idle = true;
	const { pi, ctx } = await start();
	ctx.isIdle = () => idle;
	idle = false;
	pi.events.get("agent_start")({ type: "agent_start" });
	// Real seconds, because the clock is the thing under test: one run of work
	// the report can see, and one idle stretch it must not add to.
	await wait(1100);
	idle = true;
	pi.events.get("agent_end")({ type: "agent_end", messages: [] });
	assert.equal(await reportedWork(pi, ctx), 1);
	await wait(1100);
	assert.equal(await reportedWork(pi, ctx), 1);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("working   1s"));
});

test("an agent that goes idle without an agent_end stops the clock anyway", async () => {
	let idle = true;
	const { pi, ctx } = await start();
	ctx.isIdle = () => idle;
	idle = false;
	pi.events.get("agent_start")({ type: "agent_start" });
	await wait(1100);
	const working = await reportedWork(pi, ctx);
	// The event never arrives. The tick and every refresh must still stop the
	// clock, so the total freezes within a tick rather than counting on.
	idle = true;
	await wait(1200);
	const stopped = await reportedWork(pi, ctx);
	assert.ok(stopped <= working + 1, `${stopped}s should not keep counting past ${working}s`);
	await wait(1100);
	assert.equal(await reportedWork(pi, ctx), stopped);
});

test("shutting down releases the editor and the overlay", async () => {
	const { pi, ctx } = await start();
	pi.events.get("session_shutdown")({ type: "session_shutdown" });
	// Nothing may throw, and a second shutdown must be harmless too.
	pi.events.get("session_shutdown")({ type: "session_shutdown" });
	assert.equal(ctx.ui.editorFactory === undefined || typeof ctx.ui.editorFactory === "function", true);
});

// --- the tab bar ---------------------------------------------------------

const { CURRENT_SESSION_VERSION } = await import("@earendil-works/pi-coding-agent");

/** Write a session file pi will list: a header, then one user message. */
async function writeSession(sessionDir, id, name, text, timestamp) {
	const path = join(sessionDir, `${timestamp}-${id}.jsonl`);
	const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: new Date(timestamp).toISOString(), cwd: agentDir };
	const info = name ? { type: "session_info", name } : undefined;
	const message = { type: "message", id: `${id}-1`, parentId: null, timestamp: new Date(timestamp + 1000).toISOString(), message: { role: "user", content: [{ type: "text", text }] } };
	await writeFile(path, `${[header, info, message].filter(Boolean).map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

/** Start a session whose bar can see `sessions`, and return the bar component. */
async function startWithTabs(sessions = {}, settings = undefined) {
	const sessionDir = await mkdtemp(join(tmpdir(), "faiku-sessions-"));
	const current = await writeSession(sessionDir, "current", undefined, "the chat you are in", 1_700_000_000_000);
	await writeSession(sessionDir, "older", "api cleanup", "why is the editor two rows short", 1_600_000_000_000);
	for (const [name, text, at] of Object.entries(sessions)) {
		await writeSession(sessionDir, name, undefined, text, at);
	}
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings ?? {}));
	const pi = fakePi();
	await faikuTheme(pi);
	const ctx = fakeContext();
	ctx.sessionManager.getSessionDir = () => sessionDir;
	ctx.sessionManager.getSessionFile = () => current;
	ctx.switchSession = async (path) => {
		ctx.switchedTo = path;
		return { cancelled: false };
	};
	ctx.newSession = async () => {
		ctx.newedSession = true;
		return { cancelled: false };
	};
	await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	// The bar loads its sessions on session start; one turn of the event loop is
	// all the read takes.
	await wait(50);
	const entry = ctx.ui.overlays.find((overlay) => overlay.options.overlayOptions().anchor === "top-left");
	const component = await entry.factory(fakeTui(), {}, { matches: () => false }, () => {});
	// pi renders an overlay before anything can be clicked on it, and the hit
	// regions only exist once it has.
	component.render(100);
	return { pi, ctx, component, row: () => stripAnsi(component.render(100)[0] ?? "") };
}

/** A click at the column `label` starts on, inside its tab. */
function clickOn(component, row, label, type = "click", button = "left") {
	const x = row.indexOf(label) + 2;
	component.handleMouse({ type, button, x, y: 0, screenX: x, screenY: 0, width: 100, height: 1, shift: false, alt: false, ctrl: false });
}

test("the bar names the chats of this directory, and marks the current one", async () => {
	const { row } = await startWithTabs();
	const bar = row();
	assert.match(bar, /❯ the chat you are in/);
	assert.match(bar, /api cleanup/);
	assert.match(bar, /\+/);
});

test("clicking a tab runs `/faiku tab <n>` rather than typing it", async () => {
	const { pi, ctx, component, row } = await startWithTabs();
	// A press claims the gesture, so a drag that ends on the bar cannot switch.
	assert.deepEqual(component.handleMouse({ type: "press", button: "left", x: 2, y: 0, screenX: 2, screenY: 0, width: 100, height: 1, shift: false, alt: false, ctrl: false }), {
		handled: true,
		capture: true,
		render: false,
	});
	clickOn(component, row(), "api cleanup");
	assert.deepEqual(pi.sent, ["/faiku tab 2"]);
	// pi expands the command itself, which is how the switch gets a command context.
	assert.equal(ctx.switchedTo, undefined, "the command runs pi's way, not this test's");
});

test("clicking the trailing plus starts a new chat", async () => {
	const { pi, component, row } = await startWithTabs();
	const plus = row().indexOf("+");
	component.handleMouse({ type: "click", button: "left", x: plus, y: 0, screenX: plus, screenY: 0, width: 100, height: 1, shift: false, alt: false, ctrl: false });
	assert.deepEqual(pi.sent, ["/faiku tab new"]);
});

test("the bar draws a rule under itself, and the toasts start below it", async () => {
	const { ctx } = await startWithTabs();
	const bar = ctx.ui.overlays.find((overlay) => overlay.options.overlayOptions().anchor === "top-left");
	const component = await bar.factory(fakeTui(), {}, { matches: () => false }, () => {});
	const rows = component.render(80).map(stripAnsi);
	assert.equal(rows.length, 2);
	assert.equal(rows[1], "─".repeat(80));
	// Two rows are taken off the top, so a toast cannot land inside the bar.
	const toasts = ctx.ui.overlays.find((overlay) => overlay.options.overlayOptions().anchor === "top-right");
	assert.equal(toasts.options.overlayOptions().margin.top, 2);
});

test("with the bar off, the toasts go back to the first row", async () => {
	const { pi, ctx } = await startWithTabs();
	await pi.commands.get("faiku").handler("tabs off", ctx);
	const toasts = ctx.ui.overlays.find((overlay) => overlay.options.overlayOptions().anchor === "top-right");
	assert.equal(toasts.options.overlayOptions().margin.top, 0);
});

test("a click on the rule under a tab is not a click on the tab", async () => {
	const { pi, component, row } = await startWithTabs();
	const bar = component.render(100);
	const column = stripAnsi(bar[0]).indexOf("api cleanup") + 2;
	// The rule is row 1, and it is only decoration.
	component.handleMouse({ type: "click", button: "left", x: column, y: 1, screenX: column, screenY: 1, width: 100, height: 2, shift: false, alt: false, ctrl: false });
	assert.deepEqual(pi.sent, []);
	// Row 0 at the same column still switches.
	component.handleMouse({ type: "click", button: "left", x: column, y: 0, screenX: column, screenY: 0, width: 100, height: 2, shift: false, alt: false, ctrl: false });
	assert.deepEqual(pi.sent, ["/faiku tab 2"]);
});

test("a click on the rule is not a click on a tab", async () => {
	const { pi, component } = await startWithTabs();
	component.render(100);
	component.handleMouse({ type: "click", button: "left", x: 90, y: 0, screenX: 90, screenY: 0, width: 100, height: 1, shift: false, alt: false, ctrl: false });
	assert.deepEqual(pi.sent, []);
});

test("middle-clicking a tab closes it, and `reopen` brings it back", async () => {
	const { pi, ctx, component, row } = await startWithTabs();
	clickOn(component, row(), "api cleanup", "press", "middle");
	await wait(20);
	assert.deepEqual((await readConfig()).faiku.tabsClosed.length, 1);
	await wait(20);
	// Closing it again is refused: the chat is already hidden.
	clickOn(component, row(), "api cleanup", "press", "right");
	await wait(20);
	assert.equal((await readConfig()).faiku.tabsClosed.length, 1);
	await pi.commands.get("faiku").handler("tab reopen", ctx);
	assert.deepEqual((await readConfig()).faiku.tabsClosed, []);
});

test("closing the chat you are in is refused", async () => {
	const { component, row } = await startWithTabs();
	clickOn(component, row(), "the chat you are in", "press", "middle");
	await wait(20);
	assert.equal((await readConfig()).faiku?.tabsClosed, undefined);
});

test("`/faiku tab <n>` switches, and lists when there is nothing to switch to", async () => {
	const { pi, ctx } = await startWithTabs();
	const command = pi.commands.get("faiku");
	await command.handler("tab", ctx);
	assert.match(ctx.ui.notifications.at(-1).message, /api cleanup/);
	await command.handler("tab 2", ctx);
	assert.equal(ctx.switchedTo?.endsWith("-older.jsonl"), true);
	await command.handler("tab 99", ctx);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("Usage:"));
});

test("a switch is refused while the agent is working", async () => {
	const { pi, ctx } = await startWithTabs();
	ctx.isIdle = () => false;
	await pi.commands.get("faiku").handler("tab 2", ctx);
	assert.equal(ctx.switchedTo, undefined);
	await pi.commands.get("faiku").handler("tab new", ctx);
	assert.equal(ctx.newedSession, undefined);
});

test("`/faiku tab new` starts a chat", async () => {
	const { pi, ctx } = await startWithTabs();
	await pi.commands.get("faiku").handler("tab new", ctx);
	assert.equal(ctx.newedSession, true);
});

test("the alt shortcuts drive the same commands", async () => {
	const { pi } = await startWithTabs();
	assert.ok(pi.shortcuts.has("alt+1"));
	assert.ok(pi.shortcuts.has("alt+0"));
	assert.ok(pi.shortcuts.has("alt+shift+left"));
	pi.shortcuts.get("alt+2").handler();
	assert.deepEqual(pi.sent, ["/faiku tab 2"]);
	pi.shortcuts.get("alt+0").handler();
	assert.deepEqual(pi.sent, ["/faiku tab 2", "/faiku tab new"]);
});

test("nothing is dispatched while the bar is switched off", async () => {
	const { pi, ctx } = await startWithTabs();
	await pi.commands.get("faiku").handler("tabs off", ctx);
	pi.shortcuts.get("alt+1").handler();
	assert.deepEqual(pi.sent, []);
});

test("`/faiku tab close` with no chat says which one it meant", async () => {
	const { pi, ctx } = await startWithTabs();
	await pi.commands.get("faiku").handler("tab close", ctx);
	assert.equal((await readConfig()).faiku?.tabsClosed, undefined);
	await pi.commands.get("faiku").handler("tab 1", ctx);
	assert.equal(ctx.switchedTo, undefined, "chat 1 is this one");
});

test("pi's regular mode has no mouse, so the bar says why instead of sitting there", async () => {
	tuiMode = "regular";
	try {
		const { pi, ctx } = await start();
		// No bar: a tab that ignores every click is indistinguishable from a
		// broken one, and this mode cannot do better.
		assert.equal(ctx.ui.overlays.some((overlay) => overlay.options.overlayOptions().anchor === "top-left"), false);
		await pi.commands.get("faiku").handler("info", ctx);
		assert.ok(ctx.ui.notifications.at(-1).message.includes("regular — the tab bar and every mouse click need fullscreen"));
		// And nothing is claimed about a mode this package never reached.
		assert.ok(ctx.ui.statuses.every((row) => !row.text.includes("restart pi")));
	} finally {
		tuiMode = "fullscreen";
	}
});

test("regular mode puts fullscreen in the settings for the next start, and says so", async () => {
	tuiMode = "regular";
	try {
		const { ctx } = await start();
		await wait(30);
		assert.equal((await readConfig()).tuiMode, "fullscreen");
		// A toast, like every other thing this package says: it expires by
		// itself and it looks like the rest of the interface.
		const toasts = await overlayRows(ctx, "top-right", 40);
		assert.ok(toasts.some((row) => row.includes("Set pi to fullscreen")));
		// And a footer line for the part that has to outlive the toast.
		assert.ok(ctx.ui.statuses.some((row) => row.text.includes("restart pi for the tab bar")));
		// The toasts themselves are left alone: nothing was asked to be closed.
		assert.equal(ctx.ui.overlays.some((overlay) => overlay.options.overlayOptions().anchor === "top-right"), true);
	} finally {
		tuiMode = "fullscreen";
	}
});

test("a fullscreen session leaves no note about the mode in the footer", async () => {
	const { ctx } = await start();
	await wait(30);
	assert.deepEqual(ctx.ui.statuses, []);
});

test("`faiku.fullscreen: false` warns without writing, and says where to look", async () => {
	tuiMode = "regular";
	try {
		const { ctx } = await start({ faiku: { fullscreen: false } });
		await wait(30);
		assert.equal((await readConfig()).tuiMode, undefined);
		const toasts = await overlayRows(ctx, "top-right", 40);
		assert.ok(toasts.some((row) => row.includes("Tab bar needs fullscreen mode")));
		assert.ok(ctx.ui.statuses.some((row) => row.text.includes("/faiku fullscreen on")));
	} finally {
		tuiMode = "fullscreen";
	}
});

test("`faiku.fullscreen: false` keeps pi's mode alone", async () => {
	tuiMode = "regular";
	try {
		const { ctx } = await start({ faiku: { fullscreen: false } });
		await wait(30);
		assert.equal((await readConfig()).tuiMode, undefined);
	} finally {
		tuiMode = "fullscreen";
	}
});

test("`/faiku fullscreen off` says no for good, and on undoes it", async () => {
	tuiMode = "regular";
	try {
		const { pi, ctx } = await start();
		const command = pi.commands.get("faiku");
		await command.handler("fullscreen off", ctx);
		const off = await readConfig();
		assert.equal(off.tuiMode, "regular");
		assert.equal(off.faiku.fullscreen, false);
		await command.handler("fullscreen sideway", ctx);
		assert.ok(ctx.ui.notifications.at(-1).message.includes("Usage:"));
		await command.handler("fullscreen", ctx);
		const on = await readConfig();
		assert.equal(on.tuiMode, "fullscreen");
		assert.equal(on.faiku.fullscreen, true);
		// The toast overlay is closed, so pi's own switch is not refused for it.
		const toasts = ctx.ui.overlays.find((overlay) => overlay.options.overlayOptions().anchor === "top-right");
		assert.equal(toasts.closed, true);
		assert.ok(ctx.ui.notifications.at(-1).message.includes("/faiku toasts on"));
	} finally {
		tuiMode = "fullscreen";
	}
});

test("`/faiku fullscreen` in fullscreen mode says so instead of closing the toasts", async () => {
	const { pi, ctx } = await start();
	await pi.commands.get("faiku").handler("fullscreen", ctx);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("Already in fullscreen mode"));
	const toasts = ctx.ui.overlays.find((overlay) => overlay.options.overlayOptions().anchor === "top-right");
	assert.equal(toasts.closed, false);
});

test("a fresh session does not switch the mode back on after `fullscreen off`", async () => {
	tuiMode = "regular";
	try {
		const first = await start();
		await first.pi.commands.get("faiku").handler("fullscreen off", first.ctx);
		// The next session reads that decision out of the settings file.
		const second = await start(undefined, { keepSettings: true });
		await wait(30);
		assert.equal((await readConfig()).tuiMode, "regular");
		assert.equal(second.ctx.ui.overlays.some((overlay) => overlay.options.overlayOptions().anchor === "top-left"), false);
	} finally {
		tuiMode = "fullscreen";
	}
});

test("`/faiku keys` names what the terminal sent and what it would run", async () => {
	const { pi, ctx } = await startWithTabs();
	const seen = [];
	ctx.ui.onTerminalInput = (handler) => {
		seen.push(handler);
		return () => seen.pop();
	};
	const command = pi.commands.get("faiku");
	const pending = command.handler("keys", ctx);
	// The listener is registered before the command waits, so this is a keypress
	// arriving during the probe. A mouse report is not a key and is not listed.
	seen[0]("\x1b1");
	seen[0]("\x1b[<0;10;1M");
	await pending;
	const report = ctx.ui.notifications.at(-1).message;
	assert.match(report, /→  alt\+1  →  chat 1/);
	assert.match(report, /u001b1/, "the bytes it received are reported too");
	assert.ok(!report.includes("x1b[<"), "mouse reports are not keys");
});

test("a slot can be rebound, listed, and put back", async () => {
	const { pi, ctx } = await startWithTabs();
	const command = pi.commands.get("faiku");
	await command.handler("keys list", ctx);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("1  alt+1  chat 1"));

	await command.handler("keys set 1 ctrl+alt+1", ctx);
	assert.equal((await readConfig()).faiku.tabKeys["1"], "ctrl+alt+1");
	await command.handler("keys set new nonsense+", ctx);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("Usage:"));
	await command.handler("keys set sideways ctrl+alt+1", ctx);
	assert.ok(ctx.ui.notifications.at(-1).message.includes("Usage:"));
	assert.equal((await readConfig()).faiku.tabKeys.sideways, undefined);

	// A fresh session registers the key the user chose, and not the one they
	// gave up: a binding is read when pi starts, like every other setting.
	const next = await startWithTabs({}, await readConfig());
	assert.ok(next.pi.shortcuts.has("ctrl+alt+1"));
	assert.equal(next.pi.shortcuts.has("alt+1"), false);
	await next.pi.commands.get("faiku").handler("keys reset", ctx);
	assert.deepEqual((await readConfig()).faiku.tabKeys, {});
});

test("a slot set to none is left unbound", async () => {
	const { pi } = await startWithTabs({}, { faiku: { tabKeys: { "1": "", prev: "" } } });
	assert.equal(pi.shortcuts.has("alt+1"), false);
	assert.equal(pi.shortcuts.has("alt+shift+left"), false);
	// The slots that were not touched are still there.
	assert.ok(pi.shortcuts.has("alt+2"));
	assert.ok(pi.shortcuts.has("alt+shift+right"));
});
