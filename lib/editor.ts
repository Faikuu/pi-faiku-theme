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
 */

import { CURSOR_MARKER, type TuiMouseEvent, type TuiMouseEventResult, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { bottomBorder, GLYPHS, joinParts, sideRow, sideRowParts, topBorder } from "./box.ts";
import { type FaikuConfig, MIN_BOX_WIDTH, MIN_COMFORTABLE_WIDTH } from "./config.ts";
import { formatInt } from "./format.ts";
import { readBorderLabel, readScrollLabel, readVisibleLineCount, splitEditorLines } from "./frame.ts";
import { renderHeader, renderHintRail } from "./hud.ts";
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

export class FaikuEditor extends CustomEditor {
	private readonly options: FaikuEditorOptions;
	private readonly faikuKeybindings: KeybindingsManager;
	/** Bracketed-paste payload being accumulated for the toast, if any. */
	private faikuPasteBuffer: string | null = null;
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
		if (showRail) lines.push(renderHintRail(info, width));
		return lines;
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
		const pasted = this.capturePaste(data);
		super.handleInput(data);
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
