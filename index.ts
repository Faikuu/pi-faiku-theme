/**
 * FaikuTheme
 *
 * A pi package with two halves that belong together:
 *
 * 1. `themes/faiku.json` — opencode's default dark palette, mapped onto pi's
 *    theme roles, so the whole interface is amber-on-charcoal instead of pi's
 *    blue.
 * 2. This extension — an opencode-style ASCII input box drawn around pi's own
 *    editor, and a top-right notification whenever text is copied or pasted.
 *
 * The box is a reframe, not a reimplementation: `FaikuEditor` asks pi's editor
 * for its layout and wraps the result, so word wrap, scrolling, the IME cursor
 * and autocomplete keep working exactly as they do without the package. Every
 * piece is switchable from `settings.json` and from `/faiku`.
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
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
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { blockChoices, COLLAPSE_MODES, describeDeferredCollapse, describeEffect, planCollapse, tallyBlocks, type BlockTally, type CollapseMode } from "./lib/collapse.ts";
import { configPatch, describeConfig, type FaikuConfig, parseConfig } from "./lib/config.ts";
import { createWorkClock } from "./lib/clock.ts";
import { FaikuEditor, previewFrame } from "./lib/editor.ts";
import { formatDuration } from "./lib/format.ts";
import { createDirtyProbe, readGitBranch, type DirtyProbe } from "./lib/git.ts";
import { collectInfo, emptyInfo, type FaikuInfo } from "./lib/info.ts";
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
} as const satisfies Record<string, keyof FaikuConfig>;

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
					margin: { top: 1, right: 1, bottom: 0, left: 0 },
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

	function unmountOverlay(): void {
		closing?.();
		overlay = undefined;
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
			const [verb = "info", ...rest] = args.trim().split(/\s+/);
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
		requestRender();
	});

	pi.on("agent_end", (_event: AgentEndEvent) => {
		clock.stop();
		refresh();
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
		tui = undefined;
		info = emptyInfo();
		ctx = undefined;
	});
}
