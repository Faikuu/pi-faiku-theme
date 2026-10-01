/**
 * FaikuTheme
 *
 * A pi package with two halves that belong together:
 *
 * 1. `themes/faiku.json` — opencode's default dark palette, mapped onto pi's
 *    theme roles, so the whole interface is amber-on-charcoal instead of pi's
 *    blue.
 * 2. This extension — an opencode-style ASCII input box drawn around pi's own
 *    editor, a top-right notification whenever text is copied or pasted, and a
 *    row of session tabs pinned to the top of the terminal.
 *
 * The box is a reframe, not a reimplementation: `FaikuEditor` asks pi's editor
 * for its layout and wraps the result, so word wrap, scrolling, the IME cursor
 * and autocomplete keep working exactly as they do without the package. Every
 * piece is switchable from `settings.json` and from `/faiku`.
 */

import { SessionManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionEvent,
	KeybindingsManager,
	ModelSelectEvent,
	SessionStartEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TuiMouseEvent, TuiMouseEventResult, TUI } from "@earendil-works/pi-tui";
import { parseKey } from "@earendil-works/pi-tui";
import { blockChoices, COLLAPSE_MODES, describeDeferredCollapse, describeEffect, planCollapse, tallyBlocks, type BlockTally, type CollapseMode } from "./lib/collapse.ts";
import { configPatch, describeConfig, type FaikuConfig, parseConfig } from "./lib/config.ts";
import { createWorkClock } from "./lib/clock.ts";
import { FaikuEditor, previewFrame } from "./lib/editor.ts";
import { formatDuration } from "./lib/format.ts";
import { createDirtyProbe, readGitBranch, type DirtyProbe } from "./lib/git.ts";
import { collectInfo, emptyInfo, type FaikuInfo } from "./lib/info.ts";
import {
	createTabStore,
	describeTabKeys,
	describeTabs,
	MIN_BAR_WIDTH,
	renderTabs,
	resolveTabKeys,
	tabAt,
	tabSlotAction,
	TAB_SLOTS,
	type SessionSummary,
	type TabKeyBinding,
	type TabRegion,
	type TabStore,
} from "./lib/tabs.ts";
import { createToastStore, renderToasts, type ToastKind, type ToastStore } from "./lib/toast.ts";
import { globalSettingsPath, readSettings, writeSettings } from "./lib/settings.ts";

/** The theme this package ships, selected on start and by `/faiku theme on`. */
export const THEME_NAME = "faiku";
/** How often the timer ticks and expired toasts are collected. */
const TICK_MS = 1000;

/** `/faiku <name> on|off` maps onto configuration keys. */
const TOGGLES = {
	box: "box",
	toasts: "toasts",
	theme: "applyTheme",
	header: "header",
	rail: "hintRail",
	git: "gitStatus",
	elapsed: "elapsed",
	history: "history",
	tabs: "tabs",
} as const satisfies Record<string, keyof FaikuConfig>;

/** How long `/faiku keys` listens before it reports what arrived. */
const KEY_PROBE_MS = 5000;

/**
 * Shortcuts the tab bar answers to.
 *
 * pi takes any key here, not only its own action ids, so the slots are free:
 * nothing built in uses `alt` with a digit, and `alt+shift+left/right` are
 * untouched as well. The one key this bar never takes is `escape`, which pi
 * needs to stop an agent.
 *
 * Each of these only fires if the terminal actually sends the bytes behind it,
 * which is why the table is settings rather than a constant: `faiku.tabKeys`
 * rebinds any slot, and `/faiku keys` reports what the keyboard really sent.
 */

export default async function faikuTheme(pi: ExtensionAPI) {
	let config: FaikuConfig = parseConfig(await readSettings(globalSettingsPath()));
	let ctx: ExtensionContext | undefined;
	let info: FaikuInfo = emptyInfo();
	/** The timer: it runs only while the agent works, never while it waits. */
	const clock = createWorkClock();
	let branch: string | null = null;
	let probe: DirtyProbe | undefined;
	let editor: FaikuEditor | undefined;
	let tui: TUI | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let toasts: ToastStore = createToastStore({ ttlMs: config.toastTtlMs });
	let overlay: OverlayHandle | undefined;
	let closing: (() => void) | undefined;
	/** The tab bar's own overlay, with its own closer: two bars, two lifetimes. */
	let tabOverlay: OverlayHandle | undefined;
	let closingTabs: (() => void) | undefined;
	/** The sessions behind the bar. Rebuilt on every session start. */
	let tabStore: TabStore | undefined;
	/** True once this session has explained that pi is not in fullscreen mode. */
	let regularModeReported = false;
	/** True once this session has asked pi for fullscreen mode. */
	let fullscreenRequested = false;
	/** The hit regions of the last render, which is what a click is matched against. */
	let tabRegions: TabRegion[] = [];
	/** The theme that was active before Faiku applied its own. */
	let previousTheme: string | undefined;
	/**
	 * Set by `/faiku theme on`, so the command means "right now" as well as
	 * "on every session start". A session start never sets it: see applyTheme.
	 */
	let themeForced = false;
	/**
	 * Whether thinking blocks are hidden right now, and the value pi loaded this
	 * session. pi has no API for this, so the state is tracked here instead: the
	 * live value follows every flip, whichever key pressed it.
	 */
	let thinkingHidden = false;
	let thinkingHiddenAtStart = false;
	/** True once the toggle handler has been wrapped on the mounted editor. */
	let toggleWatched = false;
	/** Set when a thinking collapse was asked for with no editor to ask through. */
	let collapseDeferred = false;

	/**
	 * The keys the tab bar answers to: the defaults, with the user's on top.
	 *
	 * Per session, because it reads this session's settings — which is why a
	 * rebind takes effect on the next start, like every other setting here.
	 */
	function tabShortcuts(): TabKeyBinding[] {
		return resolveTabKeys(config.tabKeys);
	}

	/**
	 * Ask the terminal for a frame. The toast overlay is drawn on the same pass.
	 *
	 * `force` repaints every line rather than only the ones that changed, which
	 * is what a theme change needs: the text on screen has not changed, so a
	 * differential repaint would leave it in the old colors.
	 */
	function requestRender(force = false): void {
		editor?.invalidate();
		tui?.requestRender(force);
	}

	/**
	 * `agent_start` and `agent_end` are the timer's boundaries; `isIdle` is the
	 * cross-check. An agent that has gone idle ends the run even if its
	 * `agent_end` never arrived, so the clock cannot count on forever.
	 */
	function stopClockIfIdle(): void {
		if (ctx?.isIdle()) clock.stop();
	}

	/** Everything the frame shows, refreshed only when something changed. */
	function refresh(): void {
		if (!ctx) return;
		probe?.refresh();
		stopClockIfIdle();
		info = collectInfo(ctx, {
			elapsedMs: clock.elapsed(),
			branch,
			dirty: probe?.get() ?? null,
		});
		if (!config.elapsed) info = { ...info, elapsedMs: 0 };
	}

	/** Show a toast and make sure it is on screen. */
	function notify(kind: ToastKind, label: string, detail?: string): void {
		if (!config.enabled || !config.toasts) return;
		toasts.push(kind, label, detail);
		overlay?.setHidden(false);
		requestRender();
	}

	/**
	 * The toast stack: a non-capturing overlay in the top-right corner.
	 *
	 * `custom()` resolves only when the overlay closes, so it is never awaited
	 * here — the handle from `onHandle` is what the rest of the extension uses.
	 */
	function mountOverlay(context: ExtensionContext): void {
		if (overlay || !config.enabled || !config.toasts || context.mode !== "tui") return;
		const component: Component & { dispose?(): void } = {
			render: (width: number) => renderToasts(toasts.items(), width),
			invalidate: () => undefined,
		};
		void context.ui
			.custom<void>((activeTui, _theme, _keybindings: KeybindingsManager, done: (result: void) => void) => {
				tui = activeTui;
				closing = () => {
					closing = undefined;
					done();
				};
				return component;
			}, {
				overlay: true,
				overlayOptions: () => ({
					anchor: "top-right",
					width: config.toastWidth,
					minWidth: 18,
					// Below the tab bar, which is a row of tabs and a row of rule.
					// A dynamic option, because the bar is not always on.
					margin: { top: tabBarHeight(), right: 1, bottom: 0, left: 0 },
					// A notification must never take a keystroke.
					nonCapturing: true,
					visible: (termWidth: number) => termWidth >= 40,
				}),
				onHandle: (handle) => {
					overlay = handle;
				},
			})
			.then(() => {
				// Reached when the overlay closes for any reason, including a
				// mode switch that tears the TUI down underneath it.
				overlay = undefined;
				closing = undefined;
			})
			.catch(() => {
				overlay = undefined;
				closing = undefined;
			});
	}

	/**
	 * How many rows the tab bar takes off the top of the screen, so the toasts
	 * start under it instead of inside it. Zero whenever the bar is not drawn:
	 * hidden by configuration, or hidden because pi is not in fullscreen mode.
	 */
	function tabBarHeight(): number {
		if (!config.enabled || !config.tabs) return 0;
		return tui?.mode === "fullscreen" ? 2 : 0;
	}

	function unmountOverlay(): void {
		closing?.();
		overlay = undefined;
	}

	/**
	 * The sessions behind the bar.
	 *
	 * `SessionManager.list` reads every session file in the directory, so this
	 * runs on session start and on demand, never on a tick. The session pi is
	 * showing is added by hand when the listing does not have it yet — a session
	 * with no messages is not written to disk, and an unsaved session still
	 * needs a tab.
	 */
	async function loadSessions(): Promise<SessionSummary[]> {
		if (!ctx) return [];
		const sessions: SessionSummary[] = (await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir())).map((session) => ({
			path: session.path,
			name: session.name,
			firstMessage: session.firstMessage,
			messageCount: session.messageCount,
			modified: session.modified.getTime(),
		}));
		const currentPath = ctx.sessionManager.getSessionFile();
		if (currentPath && !sessions.some((session) => session.path === currentPath)) {
			sessions.push({
				path: currentPath,
				name: ctx?.sessionManager.getSessionName(),
				firstMessage: "",
				messageCount: ctx?.sessionManager.getBranch().length ?? 0,
				modified: Date.now(),
			});
		}
		return sessions;
	}

	/**
	 * The tab bar: a non-capturing overlay across the top row.
	 *
	 * Non-capturing is the whole point — the bar must not take a keystroke, or
	 * typing in the editor would go to a row that is only a picture of where you
	 * are. `pi-tui` still hands it mouse events, which is how a click on a tab
	 * reaches anything at all.
	 *
	 * Both of those need pi's fullscreen renderer. Its regular mode has no fixed
	 * screen to pin a row to and no mouse at all, so there the bar is not drawn
	 * and the reason is said once rather than left to be discovered by clicking
	 * a tab that does nothing.
	 */
	function mountTabBar(context: ExtensionContext): void {
		if (tabOverlay || !config.enabled || !config.tabs || context.mode !== "tui") return;
		if (tui && tui.mode !== "fullscreen") {
			reportRegularMode();
			return;
		}
		// The renderer is right, so a note about it is stale news.
		rememberStatus(undefined);
		const component: Component & { dispose?(): void } = {
			render: (width: number) => {
				const bar = renderTabs(tabStore?.tabs() ?? [], width);
				tabRegions = bar.regions;
				return bar.lines;
			},
			invalidate: () => undefined,
			handleMouse: (event) => onTabMouse(event),
		};
		void context.ui
			.custom<void>((activeTui, _theme, _keybindings: KeybindingsManager, done: (result: void) => void) => {
				// The editor may not be mounted, so the mode is only known here.
				if (activeTui.mode !== "fullscreen") {
					reportRegularMode();
					return { render: () => [], invalidate: () => undefined };
				}
				tui = activeTui;
				closingTabs = () => {
					closingTabs = undefined;
					done();
				};
				return component;
			}, {
				overlay: true,
				overlayOptions: () => ({
					anchor: "top-left",
					width: "100%",
					// Row 0, flush to both edges: this is a bar, not a card.
					margin: 0,
					nonCapturing: true,
					visible: (termWidth: number) => termWidth >= MIN_BAR_WIDTH,
				}),
				onHandle: (handle) => {
					tabOverlay = handle;
				},
			})
			.then(() => {
				tabOverlay = undefined;
				closingTabs = undefined;
			})
			.catch(() => {
				tabOverlay = undefined;
				closingTabs = undefined;
			});
	}

	function unmountTabBar(): void {
		closingTabs?.();
		closingTabs = undefined;
		tabOverlay = undefined;
		tabRegions = [];
	}

	/**
	 * Say once that the bar needs pi's fullscreen renderer, and put that mode in
	 * the settings for next time.
	 *
	 * A tab that silently ignores every click is indistinguishable from a broken
	 * one, so the reason is given — and acted on. Two channels, because they
	 * answer different questions: the toast is what you catch at a glance and
	 * which takes itself away after its usual couple of seconds, and the footer
	 * status is the part that has to still be there when you next look at the
	 * screen. pi's own status line was the wrong home for this: it is not a
	 * notification, it does not expire, and it reads as pi talking about
	 * something else.
	 */
	function reportRegularMode(): void {
		if (regularModeReported || fullscreenRequested) return;
		regularModeReported = true;
		if (!config.fullscreen) {
			rememberStatus("faiku: needs fullscreen mode — /faiku fullscreen on");
			notify("warning", "Tab bar needs fullscreen mode", "/faiku fullscreen on, or set tuiMode in settings.json");
			return;
		}
		fullscreenRequested = true;
		void writeTuiMode("fullscreen").then((written) => {
			if (!written) return;
			rememberStatus("faiku: set to fullscreen — restart pi for the tab bar");
			notify("warning", "Set pi to fullscreen", "restart pi for the tab bar and the mouse");
		});
	}

	/**
	 * Leave a line in the footer until it is no longer true.
	 *
	 * pi's footer is not an overlay, so a note here never blocks pi's own live
	 * switches — which is the whole reason it exists here.
	 */
	function rememberStatus(text: string | undefined): void {
		try {
			ctx?.ui.setStatus("faiku", text);
		} catch {
			// A mode without a footer is a mode that cannot be told anything.
		}
	}

	/**
	 * Write pi's `tuiMode`, merged into its settings file.
	 *
	 * Safe to do from here in two ways. The write is atomic, so a reader — pi
	 * parses this file while extensions are still loading — never sees half of
	 * it. And pi re-reads that file under a lock, applying only the fields it
	 * changed itself, so the line survives whatever pi saves next. A race we
	 * happen to lose costs this one field, which the next session writes again;
	 * nothing else in the file is at risk.
	 */
	async function writeTuiMode(mode: "fullscreen" | "regular"): Promise<boolean> {
		const file = globalSettingsPath();
		if ((await readSettings(file)).tuiMode === mode) return true;
		try {
			await withFileMutationQueue(file, async () => {
				await writeSettings(file, { tuiMode: mode });
			});
			return true;
		} catch (error) {
			ctx?.ui.notify(`Could not save to ${file}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	}

	/**
	 * `/faiku fullscreen on|off`: the mode, and a way to switch without a restart.
	 *
	 * pi refuses to swap its renderer while any overlay is open, and in regular
	 * mode the only ones here are ours — so the toast stack is closed and left
	 * closed, and `/faiku toasts on` brings it back inside the new renderer.
	 * `off` also records the decision in this package's own settings, so the mode
	 * is not turned back on at the next start by a user who said no.
	 */
	async function fullscreenCommand(argument: string, commandCtx: ExtensionCommandContext): Promise<void> {
		if (argument !== "" && argument !== "on" && argument !== "off") {
			commandCtx.ui.notify("Usage: /faiku fullscreen on|off", "warning");
			return;
		}
		const wantsOff = argument === "off";
		const target = wantsOff ? "regular" : "fullscreen";
		const alreadyThere = (tui?.mode ?? target) === target;
		if (!(await persist({ fullscreen: !wantsOff }))) return;
		if (!(await writeTuiMode(target))) return;
		fullscreenRequested = !wantsOff;
		if (alreadyThere) {
			commandCtx.ui.notify(`Already in ${target} mode.`, "info");
			return;
		}
		if (wantsOff) {
			commandCtx.ui.notify("tuiMode regular. Restart to go back to the inline view.", "info");
			return;
		}
		// Out of pi's way, so the switch in /settings is not refused for an overlay.
		unmountOverlay();
		commandCtx.ui.notify(
			"tuiMode fullscreen. Now /settings → TUI mode → fullscreen, then /faiku toasts on to bring the notifications back.",
			"info",
		);
	}

	/**
	 * `/faiku keys`: what did the terminal actually send?
	 *
	 * A shortcut only fires if the bytes arrive, and "Option sends Esc+" is a
	 * terminal setting rather than a promise. This listens for a few seconds,
	 * names each sequence the way pi names it, and says which bar shortcut it
	 * would run — which turns "alt+1 does nothing" into an answer.
	 */
	async function watchKeys(commandCtx: ExtensionCommandContext): Promise<void> {
		const seen: string[] = [];
		const stop = commandCtx.ui.onTerminalInput((data) => {
			// Mouse reports are not keys, and a bar that eats them would be a lie.
			if (!data.startsWith("\x1b[<")) seen.push(data);
			return undefined;
		});
		commandCtx.ui.notify(`Press the key you expected. Listening for ${KEY_PROBE_MS / 1000}s…`, "info");
		await new Promise((done) => setTimeout(done, KEY_PROBE_MS));
		stop?.();
		if (seen.length === 0) {
			commandCtx.ui.notify("Nothing arrived at all.", "info");
			return;
		}
		commandCtx.ui.notify(seen.slice(-8).map(describeSequence).join("\\n"), "info");
	}

	/** One captured sequence: its bytes, the key pi calls it, what it would do. */
	function describeSequence(data: string): string {
		const key = parseKey(data);
		if (key === undefined) return `${JSON.stringify(data)}  (pi has no name for this)`;
		const binding = tabShortcuts().find((candidate) => candidate.key === key);
		const action = binding === undefined ? undefined : binding.action;
		return `${JSON.stringify(data)}  →  ${key}${action === undefined ? "" : `  →  ${action}`}`;
	}

	/**
	 * `/faiku keys`: list, rebind, or listen.
	 *
	 * `set` is here because a shortcut that does not fire is otherwise a puzzle:
	 * the bytes a key produces are a property of the terminal, so the fix is a
	 * different key, and the user should not have to edit JSON to find one.
	 */
	async function keysCommand(words: readonly string[], commandCtx: ExtensionCommandContext): Promise<void> {
		const [verb = "", ...rest] = words;
		if (verb === "") {
			await watchKeys(commandCtx);
			return;
		}
		if (verb === "list") {
			commandCtx.ui.notify(describeTabKeys(tabShortcuts()), "info");
			return;
		}
		if (verb === "reset") {
			if (!(await persist({ tabKeys: {} }))) return;
			commandCtx.ui.notify("Tab keys are back to their defaults.", "info");
			return;
		}
		if (verb !== "set") {
			commandCtx.ui.notify("Usage: /faiku keys | keys list | keys set <slot> <key> | keys reset", "warning");
			return;
		}
		const [slot = "", key = ""] = rest;
		if (!tabSlotAction(slot) || !isBindableKey(key)) {
			commandCtx.ui.notify(
				`Usage: /faiku keys set <${TAB_SLOTS.join("|")}> <modifier+key>, e.g. /faiku keys set 1 alt+1`,
				"warning",
			);
			return;
		}
		// One empty string unbinds the slot: a key with no slot to fall back on.
		const next = { ...config.tabKeys, [slot]: key === "none" ? "" : key.toLowerCase() };
		if (!(await persist({ tabKeys: next }))) return;
		commandCtx.ui.notify(`${slot} is now ${key === "none" ? "unbound" : key.toLowerCase()}, for the next pi start.`, "info");
	}

	/** Loose enough for `alt+1`, `ctrl+alt+k`, `f5`; strict enough to catch a typo. */
	function isBindableKey(key: string): boolean {
		return /^(?:(ctrl|shift|alt|super)\+)*[a-z0-9`\-=[\]\\\\;',./!@#$%^&*()?+|{}:"<>~ ]$/i.test(key.trim());
	}

	/**
	 * One click on the bar.
	 *
	 * A left press captures the gesture, because `pi-tui` only sends the release
	 * — and with it the click — to the component that claimed the press; that is
	 * what keeps a drag that ends over the bar from switching chats. Middle and
	 * right presses close a tab: those are deliberate, and not every terminal
	 * bothers to send a click for them.
	 *
	 * Row 0 only. The rule underneath is decoration, and a region is a column
	 * range rather than a box, so without this a click on the rule at a tab's
	 * column would switch that tab.
	 */
	function onTabMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const hit = event.y === 0 ? tabAt(tabRegions, event.x) : undefined;
		if (event.type === "press" && event.button === "left") {
			return hit ? { handled: true, capture: true, render: false } : undefined;
		}
		if (event.type === "click" && event.button === "left") {
			if (!hit) return undefined;
			if (hit.kind === "new") dispatchTab("new");
			else dispatchTab(String(hit.index + 1));
			return { handled: true };
		}
		if (event.type === "press" && (event.button === "middle" || event.button === "right")) {
			if (!hit || hit.kind !== "tab") return undefined;
			void closeTab(hit.index);
			return { handled: true };
		}
		return undefined;
	}

	/**
	 * Run `/faiku tab …` the way a person would have typed it.
	 *
	 * Switching a session needs `ExtensionCommandContext`, and only a command has
	 * one — but pi expands a submitted `/command` itself, so this dispatches the
	 * real command rather than a copy of it. The alternative, typing the text
	 * into the input and pressing enter, would put the command in the prompt
	 * history and eat whatever you were in the middle of writing.
	 *
	 * The command name is checked first on purpose: text pi does not recognise
	 * as a command is a prompt, and a prompt is the last thing a stray click
	 * should cause.
	 */
	function dispatchTab(argument: string): void {
		if (!config.enabled || !config.tabs) return;
		if (!pi.getCommands().some((command) => command.name === "faiku")) return;
		pi.sendUserMessage(`/faiku tab ${argument}`, { expandPromptTemplates: true });
	}

	/** The tab before or after this one, wrapping at both ends. */
	function stepTab(direction: number): void {
		const tabs = tabStore?.tabs() ?? [];
		if (tabs.length === 0) return;
		const current = tabs.findIndex((tab) => tab.current);
		const next = (current + direction + tabs.length) % tabs.length;
		if (tabs[next]?.current) return;
		dispatchTab(String(next + 1));
	}

	/** Hide a tab for good, and remember it so `reopen` can bring it back. */
	async function closeTab(index: number): Promise<void> {
		const tab = tabStore?.tabs()[index];
		if (!tab) return;
		if (tab.current) {
			notify("info", "This is the chat you are in", "switch away before closing it");
			return;
		}
		if (!(await persist({ tabsClosed: [tab.path, ...config.tabsClosed.filter((path) => path !== tab.path)] }))) return;
		tabStore?.setClosed(config.tabsClosed);
		requestRender(true);
		notify("info", `Closed “${tab.label}”`, "/faiku tab reopen brings it back");
	}

	/** The sessions behind the bar, loaded once per session start. */
	function startTabs(context: ExtensionContext): void {
		tabStore = createTabStore({
			load: loadSessions,
			currentPath: () => ctx?.sessionManager.getSessionFile(),
			closed: config.tabsClosed,
			max: config.tabsMax,
		});
		if (config.enabled && config.tabs) mountTabBar(context);
		// The bar has nothing to draw until this lands, so the first load is not
		// a cache question and does not wait for the interval.
		void tabStore.refresh({ force: true }).then(() => requestRender(true));
	}

	/**
	 * `/faiku tab …`: list, switch, close, reopen, or start a new chat.
	 *
	 * Switching and creating are the two things that replace the session, so both
	 * refuse to run while the agent is working: taking the session out from under
	 * a running turn would lose the work it is doing.
	 */
	async function tabCommand(argument: string, commandCtx: ExtensionCommandContext): Promise<void> {
		const words = argument.trim().split(/\s+/).filter(Boolean);
		const [verb = "", ...rest] = words;
		const tabs = tabStore?.tabs() ?? [];

		if (verb === "") {
			commandCtx.ui.notify(describeTabs(tabs), "info");
			return;
		}

		if (verb === "new") {
			if (commandCtx.isIdle()) await commandCtx.newSession();
			else notify("info", "The agent is working", "esc stops it before a new chat");
			return;
		}

		if (verb === "reopen") {
			const path = tabStore?.reopen();
			if (!path) {
				notify("info", "No closed chats to reopen");
				return;
			}
			if (!(await persist({ tabsClosed: config.tabsClosed.filter((closed) => closed !== path) }))) return;
			tabStore?.setClosed(config.tabsClosed);
			requestRender(true);
			notify("info", "Reopened a chat");
			return;
		}

		if (verb === "close") {
			const position = Number.parseInt(rest[0] ?? "", 10);
			if (!Number.isInteger(position)) {
				notify("info", "Which chat? /faiku tab close <number>", "or /faiku tab to see the list");
				return;
			}
			await closeTab(position - 1);
			return;
		}

		const index = Number.parseInt(verb, 10);
		const tab = Number.isInteger(index) ? tabs[index - 1] : undefined;
		if (!tab) {
			commandCtx.ui.notify("Usage: /faiku tab <number> | new | close <number> | reopen", "warning");
			return;
		}
		if (tab.current) {
			notify("info", `Already in “${tab.label}”`);
			return;
		}
		if (!commandCtx.isIdle()) {
			notify("info", "The agent is working", "esc stops it before switching chats");
			return;
		}
		await commandCtx.switchSession(tab.path);
		// Nothing may touch the command context past this line: a session that was
		// replaced leaves it stale, and the new session brings its own bar.
	}

	/** Install the framed editor, replacing pi's own. */
	function mountEditor(context: ExtensionContext): void {
		if (!config.enabled || !config.box || context.mode !== "tui") return;
		context.ui.setEditorComponent((activeTui, theme, keybindings) => {
			tui = activeTui;
			editor = new FaikuEditor(activeTui, theme, keybindings, {
				info: () => info,
				config,
				notify,
			});
			return editor;
		});
		// After the call, not inside the factory: pi copies its own action
		// handlers into the editor it was just handed, and the thinking toggle
		// is one of them. A remount brings a fresh editor with a fresh map.
		toggleWatched = false;
		watchThinkingToggle();
	}

	/**
	 * Keep `thinkingHidden` true to what is on screen.
	 *
	 * pi exposes no way to read or set thinking visibility, but the editor
	 * carries pi's own action handlers, and the only thing that ever changes
	 * this state is `app.thinking.toggle` — whether it came from `ctrl+T` or
	 * from here. Wrapping the handler is therefore an exact way to follow it,
	 * with no settings file to race against pi's own writes.
	 */
	function watchThinkingToggle(): void {
		if (toggleWatched || !editor) return;
		const handlers = editor.actionHandlers;
		const original = handlers.get("app.thinking.toggle");
		if (!original) return;
		handlers.set("app.thinking.toggle", () => {
			original();
			thinkingHidden = !thinkingHidden;
		});
		toggleWatched = true;
	}

	/**
	 * Fire pi's own toggle, which is the only way into thinking visibility.
	 *
	 * Returns false when there is no editor to ask, which is the one case the
	 * package cannot collapse: thinking needs the faiku box mounted.
	 */
	function toggleThinking(): boolean {
		if (!editor) return false;
		const handler = editor.actionHandlers.get("app.thinking.toggle");
		if (!handler) return false;
		handler();
		return true;
	}

	/**
	 * Put the transcript in the posture `faiku.collapse` asks for.
	 *
	 * pi keeps its own keys working either way: this only sets the starting
	 * point, and `/faiku blocks` expands again afterwards.
	 */
	function applyCollapse(context: ExtensionContext): void {
		if (context.mode !== "tui") return;
		// Switched off, the package puts back the one thing it changed itself:
		// a thinking state it folded. Tool output is left wherever pi has it.
		const mode = config.enabled ? config.collapse : "off";
		const intent = planCollapse(mode, {
			hideThinkingBlock: thinkingHidden,
			toolsExpanded: context.ui.getToolsExpanded(),
			flippedThinking: thinkingHidden !== thinkingHiddenAtStart,
		});
		if (intent.thinking !== undefined) {
			if (toggleThinking()) collapseDeferred = false;
			else collapseDeferred = true;
		}
		if (intent.tools !== undefined && context.ui.getToolsExpanded() !== intent.tools) {
			context.ui.setToolsExpanded(intent.tools);
		}
	}

	/** What the branch holds, for `/faiku blocks` and its own report. */
	function tallyBranch(): BlockTally {
		return tallyBlocks(ctx?.sessionManager.getEntries() ?? []);
	}

	function unmountEditor(): void {
		editor?.dispose();
		editor = undefined;
		ctx?.ui.setEditorComponent(undefined);
	}

	/**
	 * Select the `faiku` theme, unless the user has chosen one of their own.
	 *
	 * pi's built-in `dark` and `light` are the states a session starts in, so
	 * replacing them is the whole point of installing this package. Any other
	 * theme name is somebody's deliberate choice, and overriding it on every
	 * session start would be rude. `/faiku theme on` overrides even that, once.
	 */
	function applyTheme(context: ExtensionContext): void {
		if (!config.enabled || !config.applyTheme || context.mode !== "tui") return;
		const current = context.ui.theme?.name;
		if (current === THEME_NAME) return;
		if (current !== undefined && current !== "dark" && current !== "light" && !themeForced) return;
		// Only switch when the package's own theme is actually installed, so a
		// partial install cannot leave the interface without one.
		if (!context.ui.getAllThemes().some((theme) => theme.name === THEME_NAME)) return;
		if (current) previousTheme = current;
		const result = context.ui.setTheme(THEME_NAME);
		if (!result.success) {
			context.ui.notify(`Could not apply the ${THEME_NAME} theme: ${result.error ?? "unknown error"}`, "warning");
		}
	}

	/** Put back whatever theme was in use before Faiku took over. */
	function restoreTheme(context: ExtensionContext): void {
		if (context.ui.theme?.name !== THEME_NAME || previousTheme === undefined) return;
		const result = context.ui.setTheme(previousTheme);
		if (!result.success) {
			context.ui.notify(`Could not restore the ${previousTheme} theme: ${result.error ?? "unknown error"}`, "warning");
		}
		if (previousTheme) context.ui.setTheme(previousTheme);
		previousTheme = undefined;
	}

	function startTicker(): void {
		if (ticker) return;
		ticker = setInterval(() => {
			// The clock is checked on every tick, even when the timer is hidden,
			// so it is right the moment it is turned back on.
			stopClockIfIdle();
			if (!config.enabled) return;
			const expired = toasts.tick();
			if (config.elapsed) refresh();
			if (expired || config.elapsed) requestRender();
			if (!toasts.has()) overlay?.setHidden(true);
		}, TICK_MS);
		// The clock is a nicety; it must never be the reason pi stays alive.
		if (typeof ticker.unref === "function") ticker.unref();
	}

	function stopTicker(): void {
		if (!ticker) return;
		clearInterval(ticker);
		ticker = undefined;
	}

	function startGit(context: ExtensionContext): void {
		probe?.dispose();
		probe = config.gitStatus ? createDirtyProbe(context.cwd) : undefined;
		probe?.refresh();
	}

	async function start(context: ExtensionContext): Promise<void> {
		ctx = context;
		themeForced = false;
		toggleWatched = false;
		collapseDeferred = false;
		clock.reset();
		info = emptyInfo();
		tabRegions = [];
		regularModeReported = false;
		fullscreenRequested = false;
		// Whatever the last session left in the footer is this session's news.
		rememberStatus(undefined);
		branch = config.gitStatus ? await readGitBranch(context.cwd) : null;
		startGit(context);
		toasts = createToastStore({ ttlMs: config.toastTtlMs });
		refresh();
		// The editor is mounted first so there is a TUI to repaint through: the
		// startup screen is already drawn when a session starts, and switching
		// the theme underneath it changes no text for a differential repaint to
		// notice.
		if (config.enabled && config.box) mountEditor(context);
		if (config.applyTheme) applyTheme(context);
		else restoreTheme(context);
		// After the editor, because collapsing thinking needs its action handler.
		applyCollapse(context);
		mountOverlay(context);
		// After the editor too: the bar's switches need a context that knows which
		// session is current, and a session start is the only place that is true.
		startTabs(context);
		startTicker();
		requestRender(true);
	}

	async function persist(changes: Partial<FaikuConfig>): Promise<boolean> {
		const file = globalSettingsPath();
		const previous = config;
		config = { ...config, ...changes };
		try {
			await withFileMutationQueue(file, async () => {
				await writeSettings(file, configPatch(config, changes));
			});
			return true;
		} catch (error) {
			config = previous;
			ctx?.ui.notify(`Could not save to ${file}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	}

	/** Re-apply the configuration without restarting the session. */
	async function reapply(context: ExtensionContext): Promise<void> {
		toasts = createToastStore({ ttlMs: config.toastTtlMs });
		branch = config.gitStatus ? await readGitBranch(context.cwd) : null;
		startGit(context);
		refresh();
		if (config.applyTheme) applyTheme(context);
		else restoreTheme(context);
		// Before the editor goes away: the thinking toggle is only reachable
		// through it, and a master switch off has to hand pi's transcript back
		// the way it found it.
		if (!config.enabled) applyCollapse(context);
		if (config.enabled && config.box) mountEditor(context);
		else unmountEditor();
		if (config.enabled) mountOverlay(context);
		else unmountOverlay();
		tabStore?.setClosed(config.tabsClosed);
		tabStore?.setMax(config.tabsMax);
		if (config.enabled && config.tabs) mountTabBar(context);
		else unmountTabBar();
		if (config.enabled) applyCollapse(context);
		startTicker();
		requestRender(true);
	}

	/**
	 * `/faiku blocks`: the collapsed groups in this branch, and the expansion
	 * the user picks from them.
	 *
	 * Only collapsed groups are offered, so a row that is on screen is one
	 * whose label tells the truth when it is chosen. pi expands and collapses
	 * each group as a whole, which is the same thing `ctrl+T` and `ctrl+o` do.
	 */
	async function expandBlocks(commandCtx: ExtensionCommandContext): Promise<void> {
		if (!ctx?.hasUI) {
			commandCtx.ui.notify("No picker in this mode; use ctrl+T for thinking and ctrl+o for tool output.", "warning");
			return;
		}
		const choices = blockChoices(tallyBranch(), {
			thinkingHidden,
			toolsExpanded: commandCtx.ui.getToolsExpanded(),
		});
		const picked = await commandCtx.ui.select("Collapsed blocks", choices.map((choice) => choice.label));
		if (picked === undefined) return;
		const choice = choices.find((row) => row.label === picked);
		if (!choice) return;

		let blocked = false;
		switch (choice.effect) {
			case "expand-thinking":
				if (!toggleThinking()) blocked = true;
				break;
			case "expand-tools":
				commandCtx.ui.setToolsExpanded(true);
				break;
			case "expand-all":
				if (!toggleThinking()) blocked = true;
				commandCtx.ui.setToolsExpanded(true);
				break;
			case "collapse-all":
				if (!thinkingHidden && !toggleThinking()) blocked = true;
				commandCtx.ui.setToolsExpanded(false);
				break;
		}
		if (blocked) commandCtx.ui.notify(describeDeferredCollapse(), "warning");
		requestRender(true);
		commandCtx.ui.notify(describeEffect(choice.effect), "info");
	}

	pi.registerCommand("faiku", {
		description: "Toggle the Faiku input box, theme and clipboard notifications",
		handler: async (args: string, commandCtx: ExtensionCommandContext) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const [verb = "info", ...rest] = words;
			const command = verb.toLowerCase();
			const argument = rest.join(" ").trim();
			// `/faiku box off` switches the box; `/faiku off` switches everything.
			const target = argument === "on" ? true : argument === "off" ? false : undefined;

			if (command in TOGGLES) {
				const key = TOGGLES[command as keyof typeof TOGGLES];
				if (target === undefined) {
					commandCtx.ui.notify(`/faiku ${command} needs on or off.`, "warning");
					return;
				}
				if (!(await persist({ [key]: target }))) return;
				if (command === "theme" && target) themeForced = true;
				await reapply(commandCtx);
				commandCtx.ui.notify(`Faiku ${command} ${target ? "on" : "off"}.`, "info");
				return;
			}

			switch (command) {
				case "on":
				case "off": {
					const enabled = command === "on";
					if (!(await persist({ enabled }))) return;
					await reapply(commandCtx);
					commandCtx.ui.notify(enabled ? "Faiku on." : "Faiku off; pi's own editor and theme are back.", "info");
					return;
				}
				case "padding": {
					if (argument !== "comfortable" && argument !== "compact") {
						commandCtx.ui.notify("Usage: /faiku padding comfortable|compact", "warning");
						return;
					}
					if (!(await persist({ padding: argument }))) return;
					requestRender();
					commandCtx.ui.notify(`Faiku padding ${argument}.`, "info");
					return;
				}
				case "collapse": {
					if (!COLLAPSE_MODES.includes(argument as CollapseMode)) {
						commandCtx.ui.notify("Usage: /faiku collapse all|thinking|tools|off", "warning");
						return;
					}
					const mode = argument as CollapseMode;
					if (!(await persist({ collapse: mode }))) return;
					applyCollapse(commandCtx);
					requestRender(true);
					commandCtx.ui.notify(`Faiku collapse ${mode}.`, "info");
					return;
				}
				case "tab": {
				await tabCommand(argument, commandCtx);
				return;
			}
			case "keys": {
				await keysCommand(rest, commandCtx);
				return;
			}
			case "fullscreen": {
				await fullscreenCommand(argument, commandCtx);
				return;
			}
			case "blocks": {
					await expandBlocks(commandCtx);
					return;
				}
				case "placeholder": {
					if (argument === "") {
						commandCtx.ui.notify("Usage: /faiku placeholder <text>", "warning");
						return;
					}
					if (!(await persist({ placeholder: argument }))) return;
					requestRender();
					commandCtx.ui.notify(`Placeholder set to "${argument}".`, "info");
					return;
				}
				case "demo": {
					refresh();
					commandCtx.ui.notify(previewFrame(info, 72, config.placeholder).join("\n"), "info");
					notify("copy", "Copied", "142 chars");
					return;
				}
				case "help": {
					commandCtx.ui.notify(
						[
							"/faiku                 show the current configuration and session",
							"/faiku on|off           master switch for box, toasts and theme",
							"/faiku box on|off       the framed input box",
							"/faiku toasts on|off    top-right copy/paste notifications",
							"/faiku theme on|off     apply the faiku theme on session start",
							"/faiku header on|off    the fact line above the box",
							"/faiku rail on|off      the line below the box",
							"/faiku git on|off       changed and untracked file counts",
							"/faiku elapsed on|off   the agent's working time",
							"/faiku history on|off   the prompt history panel above the box",
						"/faiku tabs on|off      the session tab bar at the top of the terminal",
						"/faiku tab <n>         switch to chat n on the bar",
						"/faiku tab             list the chats on the bar",
						"/faiku tab new         start a new chat",
						"/faiku tab close <n>   hide chat n from the bar",
						"/faiku tab reopen      bring back the last hidden chat",
						"/faiku keys             listen for 5s and report what the terminal sent",
						"/faiku keys list        the keys the tab bar answers to",
						"/faiku keys set <slot> <key>   rebind a slot, e.g. 1 alt+1",
						"/faiku keys reset       back to the default keys",
						"/faiku fullscreen on|off  pi's TUI mode; the tab bar needs fullscreen",
							"/faiku collapse <mode>  all | thinking | tools | off",
							"/faiku blocks           pick a collapsed block to expand",
							"/faiku padding <mode>   comfortable | compact",
							"/faiku placeholder <s>  the empty-input text",
							"/faiku demo             draw the box and fire a toast",
						].join("\n"),
						"info",
					);
					return;
				}
				case "info":
				default: {
					refresh();
					commandCtx.ui.notify(
						[
							describeConfig(config),
							...(collapseDeferred ? ["", describeDeferredCollapse()] : []),
							"",
							`working   ${formatDuration(info.elapsedMs)}${info.idle ? "" : " · running"}`,
							`model     ${info.model ?? "none"}${info.provider ? ` (${info.provider})` : ""}`,
							`context   ${info.contextPercent === null ? "unknown" : `${Math.round(info.contextPercent)}%`}`,
							`git       ${info.branch ?? "no repository"}`,
							"",
							`tab keys  ${describeTabKeys(tabShortcuts())}`,							`tui       ${tui?.mode ?? "unknown"}${tui?.mode === "fullscreen" ? "" : " — the tab bar and every mouse click need fullscreen"}`,
							"",
							`settings  ${globalSettingsPath()}`,
						].join("\n"),
						"info",
					);
					return;
				}
			}
		},
	});

	pi.on("session_start", async (_event: SessionStartEvent, sessionCtx: ExtensionContext) => {
		const settings = await readSettings(globalSettingsPath());
		config = parseConfig(settings);
		// pi has already read this into its own state by now, so it is the
		// live starting point, not a setting this package is about to write.
		thinkingHiddenAtStart = settings.hideThinkingBlock === true;
		thinkingHidden = thinkingHiddenAtStart;
		await start(sessionCtx);
	});

	pi.on("model_select", (event: ModelSelectEvent) => {
		if (event.model?.id === event.previousModel?.id) return;
		refresh();
		requestRender();
	});

	pi.on("tool_result", (_event: ToolResultEvent) => {
		refresh();
		requestRender();
	});

	pi.on("agent_start", (_event: AgentStartEvent) => {
		// Started after the refresh, so a stale idle flag cannot cancel the run
		// the event just announced; the next tick is the cross-check's turn.
		refresh();
		clock.start();
		// The busy dot belongs to the chat you are in, so the bar follows the run.
		tabStore?.setBusy(true);
		requestRender();
	});

	pi.on("agent_end", (_event: AgentEndEvent) => {
		clock.stop();
		refresh();
		tabStore?.setBusy(false);
		requestRender();
	});

	pi.on("session_shutdown", (_event: ExtensionEvent) => {
		stopTicker();
		probe?.dispose();
		probe = undefined;
		editor?.dispose();
		editor = undefined;
		closing?.();
		closing = undefined;
		overlay = undefined;
		closingTabs?.();
		closingTabs = undefined;
		tabOverlay = undefined;
		tabStore = undefined;
		tabRegions = [];
		tui = undefined;
		info = emptyInfo();
		ctx = undefined;
	});

	// Registered once, at load: pi binds the key and calls the handler from the
	// editor, so these work with the framed editor and with pi's own.
	for (const binding of tabShortcuts()) {
		const { slot, key } = binding;
		pi.registerShortcut(key as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: `Faiku: ${binding.action}`,
			handler: () => {
				if (slot === "prev") stepTab(-1);
				else if (slot === "next") stepTab(1);
				else if (slot === "new") dispatchTab("new");
				else dispatchTab(slot);
			},
		});
	}
}
