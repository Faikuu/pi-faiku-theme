/**
 * The Faiku palette: opencode's default dark theme, hex for hex.
 *
 * `themes/faiku.json` is the same palette expressed as pi theme roles, and a
 * test asserts the two stay in step. Colors are painted here rather than
 * borrowed from pi's `Theme`, because the input box has to look like opencode
 * whether or not the user selected the `faiku` theme.
 */

import { getCapabilities } from "@earendil-works/pi-tui";

export const FAIKU_PALETTE = {
	/** opencode `background`. Terminals own the real background; this is the reference. */
	background: "#212121",
	/** opencode `currentLine`: one step up from the background. */
	panel: "#252525",
	/** opencode `selection`. */
	selection: "#303030",
	/** opencode `foreground`. */
	foreground: "#e0e0e0",
	/** opencode `comment`, and the muted role for everything secondary. */
	muted: "#6a6a6a",
	/** opencode `primary`: the amber every opencode prompt is drawn in. */
	primary: "#fab283",
	/** opencode `secondary`. */
	secondary: "#5c9cf5",
	/** opencode `accent`. */
	accent: "#9d7cd8",
	red: "#e06c75",
	orange: "#f5a742",
	green: "#7fd88f",
	cyan: "#56b6c2",
	yellow: "#e5c07b",
	/** The top of the thinking ramp, opencode's `magenta` pair. */
	pink: "#d183e8",
	hotPink: "#ff5fff",
	/** opencode `border`. */
	border: "#4b4c5c",
	/** opencode `backgroundDarker`, used for the HTML export page. */
	darker: "#121212",
	/** Tinted surfaces, for the tool and custom-message rows. */
	surfacePending: "#24242c",
	surfaceSuccess: "#212a21",
	surfaceError: "#2e2222",
	surfaceCustom: "#2b2b35",
	surfaceInfo: "#2a2a33",
	/** Text one and two steps below the foreground. */
	textSubtle: "#9a9a9a",
	textFaint: "#8a8a8a",
	textStrong: "#b4b4b4",
	/** A dimmed blue, for the low end of the thinking ramp. */
	ruleSoft: "#5c7fa8",
} as const;

export type FaikuColor = keyof typeof FAIKU_PALETTE;
export type Painter = (text: string) => string;

const CUBE = [0, 95, 135, 175, 215, 255];
const GRAYS = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const clean = hex.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error(`Invalid hex color: ${hex}`);
	return {
		r: Number.parseInt(clean.slice(0, 2), 16),
		g: Number.parseInt(clean.slice(2, 4), 16),
		b: Number.parseInt(clean.slice(4, 6), 16),
	};
}

function nearest(value: number, ramp: number[]): { index: number; distance: number } {
	let index = 0;
	let distance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < ramp.length; i++) {
		const d = Math.abs(value - ramp[i]);
		if (d < distance) {
			distance = d;
			index = i;
		}
	}
	return { index, distance };
}

/** Nearest xterm-256 index, preferring the color cube only while tint survives. */
export function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	const ri = nearest(r, CUBE);
	const gi = nearest(g, CUBE);
	const bi = nearest(b, CUBE);
	const cubeIndex = 16 + 36 * ri.index + 6 * gi.index + bi.index;
	const cubeDistance = Math.abs(r - CUBE[ri.index]) + Math.abs(g - CUBE[gi.index]) + Math.abs(b - CUBE[bi.index]);

	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const gi2 = nearest(gray, GRAYS);
	const grayDistance = Math.abs(gray - GRAYS[gi2.index]);

	// A near-neutral color is genuinely gray; a tinted one is genuinely a cube entry.
	if (Math.max(r, g, b) - Math.min(r, g, b) < 10 && grayDistance < cubeDistance) return 232 + gi2.index;
	return cubeIndex;
}

const painters = new Map<string, Painter>();

/**
 * A painter for one palette color, downgraded to 256-color when the terminal
 * cannot do truecolor. Closing with `39` rather than `0` keeps the surrounding
 * style (bold, dim) intact, which matters because these nest.
 */
export function painter(hex: string): Painter {
	const mode = getCapabilities().trueColor ? "truecolor" : "256color";
	const key = `${mode}:${hex}`;
	const cached = painters.get(key);
	if (cached) return cached;
	const fn: Painter =
		mode === "truecolor"
			? (() => {
					const { r, g, b } = hexToRgb(hex);
					const open = `\x1b[38;2;${r};${g};${b}m`;
					return (text: string) => `${open}${text}\x1b[39m`;
				})()
			: (() => {
					const open = `\x1b[38;5;${hexTo256(hex)}m`;
					return (text: string) => `${open}${text}\x1b[39m`;
				})();
	painters.set(key, fn);
	return fn;
}

/** Paint by palette key, so call sites read as design rather than as hex codes. */
export function paint(color: FaikuColor, text: string): string {
	return painter(FAIKU_PALETTE[color])(text);
}

export const bold = (text: string): string => `\x1b[1m${text}\x1b[22m`;
export const dim = (text: string): string => `\x1b[2m${text}\x1b[22m`;

/** Strip SGR, OSC and DCS sequences so widths can be measured on what the terminal shows. */
export function stripAnsi(text: string): string {
	return (
		text
			// OSC: `ESC ] … BEL` or `ESC ] … ESC \`
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			// DCS, which is how pi marks the hardware cursor position.
			.replace(/\x1bP[^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
			.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			// CSI and the other escape families.
			.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")
			.replace(/\x1b[@-Z\\-_]/g, "")
	);
}
