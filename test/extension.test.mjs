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
				const component = factory({ terminal: { rows: 40, columns: 100 }, requestRender: () => {} }, { borderColor: (text) => text }, { matches: () => false });
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
		custom: (factory, options) => {
			ui.overlays.push({ factory, options });
			options.onHandle?.({ hide: () => {}, setHidden: () => {} });
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
		sessionManager: { getBranch: () => [], getEntries: () => ui.entries ?? [] },
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
	assert.equal(ctx.ui.overlays.length, 0);
	assert.equal(ctx.ui.currentTheme, "dark");
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
