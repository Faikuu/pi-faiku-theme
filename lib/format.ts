/**
 * Number, token, cost and duration formatting.
 *
 * Everything here is a pure function over plain numbers: the HUD and the toasts
 * both format the same facts, and a test asserts the awkward boundaries (zero,
 * sub-unit durations, huge token counts) rather than eyeballing them in a
 * terminal.
 */

/** `1284` -> `1 284`. A space reads better than a comma in a monospace rail. */
export function formatInt(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const rounded = Math.round(value);
	const sign = rounded < 0 ? "-" : "";
	const digits = Math.abs(rounded).toString();
	return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** `18400` -> `18.4k`, `2400000` -> `2.4M`. */
export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) {
		const thousands = value / 1000;
		return `${thousands < 100 ? thousands.toFixed(1) : Math.round(thousands)}k`;
	}
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** `0` -> `$0.00`, `0.0042` -> `$0.004`, `12.5` -> `$12.50`. */
export function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

/** `12.4` -> `12%`, `100` -> `100%`. */
export function formatPercent(value: number): string {
	if (!Number.isFinite(value)) return "0%";
	return `${Math.round(value)}%`;
}

/** `4500` -> `4s`, `252000` -> `4m12s`, `7500000` -> `2h05m`. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	const totalSeconds = Math.floor(ms / 1000);
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/** Trim a path to its last two segments: `/Users/adam/code/pi` -> `code/pi`. */
export function shortenPath(path: string, segments = 2): string {
	const cleaned = path.replace(/[\\/]+$/, "");
	if (cleaned === "") return "";
	const parts = cleaned.split(/[\\/]/).filter((part) => part !== "");
	if (parts.length <= segments) return parts.join("/");
	return parts.slice(-segments).join("/");
}
