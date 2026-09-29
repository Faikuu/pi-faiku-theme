/**
 * The Faiku input box.
 *
 * pi's `Editor` already knows how to lay out a prompt: word wrap, scroll
 * offset, the hardware cursor marker pi needs for IME placement, and the
 * autocomplete list. So this editor does not re-implement any of that. It calls
 * the base renderer, takes the result apart, and puts it back inside an
 * opencode-style frame:
 *
 * ```
 *   🧠 claude-sonnet-4-5  🔀 anthropic  🔁 thinking medium  🧮 12% · 18.4k
 * ╭────────────────────────────────────────────────────────────────╮
 * │ ❯  Ask anything…                                              │
 * │                                                                │
 * ╰────────────────────────────────────────────────────────────────╯
 *   📁 code/pi-faiku-theme  🌿 feat/theme  ⏱ 4m12s      ⏎ send  ⌃c copy
 * ```
 *
 * The base is always asked for a narrower width than the frame, so every row it
 * returns is exactly the interior width, and mouse coordinates are translated
 * back before the base sees them.
 *
 * The history panel lives here too, drawn between the header and the top rule.
 * It is not a second editor and not a second history: arrow up is handed to the
 * base, which owns the index, the draft and the undo snapshot, and the panel is
 * only what that walk looks like. The editor knows which entry the base landed
 * on, so the marker is never a guess.
 */

import { CURSOR_MARKER, getKeybindings, type Keybinding, type TuiMouseEvent, type TuiMouseEventResult, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { bottomBorder, GLYPHS, joinParts, sideRow, sideRowParts, topBorder } from "./box.ts";
import { type FaikuConfig, MIN_BOX_WIDTH, MIN_COMFORTABLE_WIDTH } from "./config.ts";
import { formatInt } from "./format.ts";
import { readBorderLabel, readScrollLabel, readVisibleLineCount, splitEditorLines } from "./frame.ts";
import { renderHeader, renderHintRail } from "./hud.ts";
import { createHistoryStore, type HistoryStore, renderHistory } from "./history.ts";
import type { FaikuInfo } from "./info.ts";
import { dim, paint, type FaikuColor } from "./palette.ts";
import { type ToastKind } from "./toast.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Columns of interior padding between the rule and the base's text. */
const PAD_X = 1;
/** Columns taken by the prompt glyph, on every text row so wraps stay aligned. */
const PROMPT_WIDTH = 3;
const PROMPT = " ❯ ";
const PROMPT_BLANK = "   ";
/** Terminal rows below which the box stops padding itself. */
const MIN_ROWS_FOR_PADDING = 20;
/** Rows the editor may claim above the box before the panel has to shrink. */
const PANEL_ROW_RESERVE = 10;
/** How long to wait for pi's own copy to land in the clipboard before reading it. */
const CLIPBOARD_SETTLE_MS = 60;

export interface FaikuEditorOptions {
	/** Current session facts. Read on every render, never cached here. */
	info: () => FaikuInfo;
	config: FaikuConfig;
	/** Report a clipboard event. */
	notify: (kind: ToastKind, label: string, detail?: string) => void;
	/** Read the clipboard, to report how much was copied. Injected for tests. */
	readClipboard?: () => Promise<string | null | undefined>;
}

/**
 * What the base keeps about the list it is showing.
 *
 * pi declares these private, so they are not part of the editor we are given;
 * the list is its own object and the two fields are its state, and the way to
 * open a directory is to ask pi for the list again rather than build one here.
 * Read through a cast, and only ever for the answer to a question the base
 * already answers: is the list up, what is on it, and is the token an `@`.
 */
interface AutocompleteInternals {
	autocompletePrefix: string;
	autocompleteList?: { getSelectedItem(): { label?: string } | undefined };
	forceFileAutocomplete(explicitTab?: boolean): void;
}

export class FaikuEditor extends CustomEditor {
	private readonly options: FaikuEditorOptions;
	private readonly faikuKeybindings: KeybindingsManager;
	/** Bracketed-paste payload being accumulated for the toast, if any. */
	private faikuPasteBuffer: string | null = null;
	/** The prompts of this session, mirroring the base's own history. */
	private readonly historyStore: HistoryStore = createHistoryStore();
	/** True while the panel is up and the arrow keys walk the list. */
	private panelOpen = false;
	/** Index into the list of the entry the base is sitting on, -1 when closed. */
	private panelIndex = -1;
	/** What was in the editor before the walk started, restored on cancel. */
	private panelDraft = "";
	/** Rows the frame adds above the first text row: header, rule, padding. */
	private chromeAbove = 0;
	private disposed = false;

	constructor(tui: TUI, theme: ConstructorParameters<typeof CustomEditor>[1], keybindings: KeybindingsManager, options: FaikuEditorOptions) {
		super(tui, theme, keybindings, { paddingX: PAD_X });
		this.options = options;
		this.faikuKeybindings = keybindings;
	}

	/** Read the clipboard the way pi reads it, if the platform offers one. */
	private static async defaultClipboard(): Promise<string | null | undefined> {
		const { getNativeClipboard } = await import("@earendil-works/pi-tui");
		const clipboard = getNativeClipboard();
		if (!clipboard) return undefined;
		return clipboard.getText();
	}

	render(width: number): string[] {
		// Below the minimum there is no room for a box that is still readable,
		// so pi's own editor is the honest answer.
		if (width < MIN_BOX_WIDTH) return super.render(width);

		const info = this.options.info();
		const config = this.options.config;
		const interior = width - 2 - PROMPT_WIDTH;
		const raw = super.render(interior);
		const frame = splitEditorLines(raw, readVisibleLineCount(this));

		const roomy = this.tui.terminal.rows >= MIN_ROWS_FOR_PADDING;
		const padRows = config.padding === "comfortable" && roomy;
		const showHeader = config.header;
		const showRail = config.hintRail;
		const empty = this.getText().trim() === "";

		const lines: string[] = [];
		if (showHeader) lines.push(renderHeader(info, width));
		if (config.history && this.panelOpen) {
			lines.push(...renderHistory(this.historyStore.entries(), this.panelIndex, width, this.historyRows()));
		}
		this.chromeAbove = lines.length + 1 + (padRows ? 1 : 0);

		const working = !info.idle;
		const frameColor: FaikuColor = working ? "primary" : "border";
		const label = this.borderLabel(frame, working);
		lines.push(this.paintBorder(topBorder(width, label, GLYPHS.rounded), frameColor, working));
		if (padRows) lines.push(this.row("", width, frameColor));

		frame.content.forEach((line, index) => {
			const body = index === 0 && empty ? this.placeholderRow(interior) : line;
			const prompt = index === 0 ? paint("primary", PROMPT) : PROMPT_BLANK;
			lines.push(this.row(prompt + body, width, frameColor));
		});

		// The base draws the autocomplete after its own bottom rule, with one
		// rule's worth of space reserved above it. A blank row here keeps that
		// arithmetic true inside the frame.
		if (frame.extra.length > 0) {
			lines.push(this.row("", width, frameColor));
			for (const line of frame.extra) lines.push(this.row(PROMPT_BLANK + line, width, frameColor));
		}
		if (padRows) lines.push(this.row("", width, frameColor));

		lines.push(this.paintBorder(bottomBorder(width, readScrollLabel(frame.bottom, "↓"), GLYPHS.rounded), frameColor, working));
		if (showRail) lines.push(renderHintRail(info, width, { history: config.history }));
		return lines;
	}

	/**
	 * How many entries the panel may show, never more than the terminal has room
	 * for: the panel is drawn in the transcript, so an unbounded list would push
	 * the conversation off the top of the screen.
	 */
	private historyRows(): number {
		const room = this.tui.terminal.rows - PANEL_ROW_RESERVE;
		return Math.max(1, Math.min(this.options.config.historyMaxVisible, room));
	}

	/** The label embedded in the top rule: pi's status, the scroll hint, or a working marker. */
	private borderLabel(frame: { top: string; bottom: string }, working: boolean): string | undefined {
		const status = readBorderLabel(frame.top);
		if (status) return status;
		const scrolled = readScrollLabel(frame.top, "↑");
		if (scrolled) return scrolled;
		return working ? "⏳ working" : undefined;
	}

	private paintBorder(parts: { text: string; kind: string }[], frameColor: FaikuColor, working: boolean): string {
		return parts
			.map((part) => {
				if (part.kind === "label") return paint(working ? "primary" : "cyan", part.text);
				if (part.kind === "corner") return paint(frameColor, part.text);
				return paint(working ? "primary" : "border", part.text);
			})
			.join("");
	}

	/** One framed row: rule, interior fitted to the frame, rule. */
	private row(interior: string, width: number, frameColor: FaikuColor): string {
		const parts = sideRowParts(interior, width, GLYPHS.rounded);
		const rule = paint(frameColor, parts.left.text);
		return `${rule}${parts.interior}${parts.fill}${paint(frameColor, parts.right.text)}`;
	}

	/**
	 * The empty state: the base's cursor block, with the placeholder dimmed
	 * after it. Built here rather than patched, because the cursor block has to
	 * stay exactly where the hardware cursor is.
	 */
	private placeholderRow(interior: number): string {
		const placeholder = this.options.config.placeholder;
		const marker = this.focused ? CURSOR_MARKER : "";
		const cursor = "\x1b[7m \x1b[0m";
		const used = PAD_X * 2 + 1 + visibleWidth(placeholder);
		const fill = Math.max(0, interior - used);
		return `${" ".repeat(PAD_X)}${marker}${cursor}${dim(paint("muted", placeholder))}${" ".repeat(fill)}${" ".repeat(PAD_X)}`;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Rows above the text (header, rule, padding) and rows below it (the
		// bottom rule, the rail) are not the base's to handle.
		const above = this.chromeAbove;
		if (event.y < above) return undefined;
		const rule = paint("border", GLYPHS.rounded.vertical);
		const pad = paint("border", " ".repeat(PAD_X));
		// The prompt glyph only exists on the first text row, and the base's
		// own padding sits inside the interior.
		const onFirstRow = event.y === above;
		const x = event.x - 1 - PAD_X - (onFirstRow ? PROMPT_WIDTH : 0);
		return super.handleMouse({ ...event, x, y: event.y - above + 1, width: event.width - 2 - PROMPT_WIDTH } as TuiMouseEvent);
	}

	handleInput(data: string): void {
		// The panel gets first refusal on the keys it owns, so a walk is never
		// interrupted by a submit and a submit is never eaten by the panel.
		if (this.panelOpen && this.handleHistoryKey(data)) return;
		if (this.descendIntoDirectory(data)) return;
		const pasted = this.capturePaste(data);
		const walking = this.matches(data, "tui.editor.historyPrevious") || this.matches(data, "tui.editor.cursorUp");
		const before = walking ? this.getText() : "";
		super.handleInput(data);
		if (walking) this.afterHistoryStep(before);
		if (pasted !== undefined) {
			this.report("paste", "Pasted", pasted === "" ? "empty" : `${formatInt(pasted.length)} chars`);
			return;
		}
		if (this.faikuKeybindings.matches(data, "app.clipboard.pasteImage")) {
			this.report("image", "Pasted image");
			return;
		}
		if (this.faikuKeybindings.matches(data, "tui.input.copy")) this.reportCopy();
	}

	/**
	 * Enter or Tab on a directory in the `@` picker opens that directory
	 * instead of closing the picker.
	 *
	 * pi accepts the completion and drops the list whatever was selected, so a
	 * directory used to mean "insert the path and stop" — one extra keystroke
	 * to get back to where the picker already could have taken you. The base is
	 * still the one that inserts: it gets the key, and only then is the list
	 * asked for again, by which point the text names the directory and the list
	 * is scoped to what is inside it.
	 *
	 * Only `@`: a slash command's arguments and an ordinary path keep pi's rule,
	 * where accepting a directory is a thing you do on the way to a file.
	 */
	private descendIntoDirectory(data: string): boolean {
		const kb = getKeybindings();
		if (!kb.matches(data, "tui.select.confirm") && !kb.matches(data, "tui.input.tab")) return false;
		if (!this.isShowingAutocomplete()) return false;
		const inner = this as unknown as AutocompleteInternals;
		if (!inner.autocompletePrefix.startsWith("@")) return false;
		const selected = inner.autocompleteList?.getSelectedItem();
		// A directory is the one kind of row whose label ends in a separator.
		if (typeof selected?.label !== "string" || !selected.label.endsWith("/")) return false;
		super.handleInput(data);
		inner.forceFileAutocomplete();
		return true;
	}

	/**
	 * Mirror every prompt the base records, so the panel lists exactly what
	 * arrow up can reach — including the older prompts pi loads when a session
	 * is resumed.
	 */
	addToHistory(text: string): void {
		super.addToHistory(text);
		this.historyStore.add(text);
	}

	private matches(data: string, action: Keybinding): boolean {
		return this.faikuKeybindings.matches(data, action);
	}

	/**
	 * Did that keypress start a walk through the history?
	 *
	 * The base is the only thing that knows: arrow up is history navigation when
	 * the cursor is at the top of the input, and a cursor movement otherwise, and
	 * only one of those two changes the text to something the store knows. So the
	 * panel opens on the outcome rather than on a copy of the base's rules.
	 */
	private afterHistoryStep(before: string): void {
		const after = this.getText();
		if (after === before) return;
		const index = this.historyStore.indexOf(after);
		if (index < 0) return;
		this.panelDraft = before;
		this.panelIndex = index;
		this.panelOpen = true;
	}

	/**
	 * One keystroke while the panel is up. Returns true when it was consumed,
	 * false when the base should have it — typing closes the panel and keeps the
	 * highlighted prompt as the new starting text.
	 */
	private handleHistoryKey(data: string): boolean {
		if (this.matches(data, "app.interrupt") || data === "\x1b") {
			this.cancelHistory();
			return true;
		}
		if (this.matches(data, "tui.editor.historyPrevious") || this.matches(data, "tui.editor.cursorUp")) {
			this.stepHistory(data, -1);
			return true;
		}
		if (this.matches(data, "tui.editor.historyNext") || this.matches(data, "tui.editor.cursorDown")) {
			this.stepHistory(data, 1);
			return true;
		}
		if (this.matches(data, "tui.input.submit")) {
			// Confirm means restore, not send: the prompt is in the input and a
			// second enter is what runs it.
			this.closeHistory();
			return true;
		}
		this.closeHistory();
		return false;
	}

	/**
	 * Move along the list by handing the key to the base, which owns the index
	 * and the draft. Only the panel's own cursor is arithmetic: the position is
	 * tracked as a step from where it was, so a prompt that appears twice in the
	 * history cannot make the marker jump back to the newer copy.
	 */
	private stepHistory(data: string, direction: -1 | 1): void {
		const before = this.getText();
		super.handleInput(data);
		const after = this.getText();
		// The end of the list: the base declined to move, so the panel stays put.
		if (after === before) return;
		// Past the newest entry the base puts the draft back, which ends the walk.
		if (this.historyStore.indexOf(after) < 0) {
			this.closeHistory();
			return;
		}
		const size = this.historyStore.size();
		this.panelIndex = Math.min(Math.max(this.panelIndex - direction, 0), size - 1);
	}

	/** Close the panel, leaving the prompt in the input and the walk finished. */
	private closeHistory(): void {
		this.panelOpen = false;
		this.panelIndex = -1;
		// Setting the text to itself is the public way out of the base's browsing
		// state: it exits the walk without touching the text or the undo stack.
		this.setText(this.getText());
	}

	/**
	 * Close the panel and give back whatever was being typed when it opened.
	 *
	 * The text is the whole draft; the cursor lands at the end of it, which is
	 * where it was in every case that matters — a prompt you were part way
	 * through typing.
	 */
	private cancelHistory(): void {
		const draft = this.panelDraft;
		this.panelDraft = "";
		this.closeHistory();
		this.setText(draft);
	}

	/**
	 * Read a bracketed paste without consuming it.
	 *
	 * The base gets the untouched input and collapses a large paste into a
	 * marker; the payload is captured here first, so the toast can report the
	 * real size of what arrived.
	 */
	private capturePaste(data: string): string | undefined {
		let payload = data;
		if (payload.includes(PASTE_START)) {
			this.faikuPasteBuffer = "";
			payload = payload.replace(PASTE_START, "");
		}
		if (this.faikuPasteBuffer === null) return undefined;
		this.faikuPasteBuffer += payload;
		const end = this.faikuPasteBuffer.indexOf(PASTE_END);
		if (end === -1) return undefined;
		const text = this.faikuPasteBuffer.slice(0, end);
		this.faikuPasteBuffer = null;
		return text;
	}

	private reportCopy(): void {
		if (this.disposed) return;
		const read = this.options.readClipboard ?? FaikuEditor.defaultClipboard;
		const settle = new Promise<void>((done) => {
			const timer = setTimeout(done, CLIPBOARD_SETTLE_MS);
			// Never hold the process open for a toast.
			if (typeof timer.unref === "function") timer.unref();
		});
		void settle
			.then(() => read())
			.then((text) => {
				if (this.disposed) return;
				if (text === undefined) this.report("copy", "Copied");
				else if (text === null || text === "") this.report("copy", "Copied", "empty");
				else this.report("copy", "Copied", `${formatInt(text.length)} chars`);
			})
			.catch(() => {
				if (!this.disposed) this.report("copy", "Copied");
			});
	}

	private report(kind: ToastKind, label: string, detail?: string): void {
		if (this.disposed) return;
		this.options.notify(kind, label, detail);
	}

	dispose(): void {
		this.disposed = true;
		this.faikuPasteBuffer = null;
		this.panelOpen = false;
		this.panelDraft = "";
	}
}

/**
 * A plain-text preview of the frame, for `/faiku demo` and the README.
 *
 * Same geometry as `render`, without an editor behind it: one bordered text
 * row, one padding row, and the two rails.
 */
export function previewFrame(info: FaikuInfo, width = 64, placeholder = "Ask anything…"): string[] {
	return [
		renderHeader(info, width),
		joinParts(topBorder(width, undefined, GLYPHS.rounded)),
		sideRow(`${paint("primary", PROMPT)}${placeholder}`, width, GLYPHS.rounded),
		sideRow("", width, GLYPHS.rounded),
		joinParts(bottomBorder(width, undefined, GLYPHS.rounded)),
		renderHintRail(info, width),
	];
}
