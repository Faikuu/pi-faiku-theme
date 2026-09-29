/**
 * Collapsing the transcript.
 *
 * pi collapses two kinds of block and only two: thinking runs, through its own
 * `hideThinkingBlock` setting and the `app.thinking.toggle` action, and tool
 * output, through `ui.setToolsExpanded()`. Assistant prose has no collapse at
 * all, so "collapse everything" here means those two and nothing more.
 *
 * The arithmetic lives in a pure function so it can be tested without a
 * terminal, and the imperative part stays in `index.ts`, where the session,
 * the editor and pi's own action handlers are.
 */

export type CollapseMode = "all" | "thinking" | "tools" | "off";

export const COLLAPSE_MODES: readonly CollapseMode[] = ["all", "thinking", "tools", "off"];

/** Parse the `collapse` key, falling back to the default for anything else. */
export function parseCollapseMode(value: unknown, fallback: CollapseMode): CollapseMode {
	return COLLAPSE_MODES.includes(value as CollapseMode) ? (value as CollapseMode) : fallback;
}

export interface CollapseState {
	/** Whether thinking is hidden right now, tracked as pi changes it. */
	hideThinkingBlock: boolean;
	/** Whether pi is showing full tool output right now. */
	toolsExpanded: boolean;
	/**
	 * Whether the live thinking state differs from the one pi loaded at session
	 * start, which is only ever true because this package flipped it.
	 */
	flippedThinking: boolean;
}

/** What to change. `undefined` means "leave it exactly as it is". */
export interface CollapseIntent {
	/** true hides thinking blocks, false shows them. */
	thinking?: boolean;
	/** true shows full tool output, false collapses it. */
	tools?: boolean;
}

export function wantsThinking(mode: CollapseMode): boolean {
	return mode === "all" || mode === "thinking";
}

export function wantsTools(mode: CollapseMode): boolean {
	return mode === "all" || mode === "tools";
}

/**
 * The flips a mode asks for, given what is on screen now.
 *
 * A mode only ever collapses. Expanding is the user's job — pi's own keys, and
 * `/faiku blocks` — so the one exception is the state this package itself
 * changed: turning the mode off puts a thinking state it flipped back, rather
 * than leaving the session in a posture the configuration no longer describes.
 */
export function planCollapse(mode: CollapseMode, state: CollapseState): CollapseIntent {
	const intent: CollapseIntent = {};
	if (wantsThinking(mode)) {
		if (!state.hideThinkingBlock) intent.thinking = true;
	} else if (state.flippedThinking && state.hideThinkingBlock) {
		intent.thinking = false;
	}
	if (wantsTools(mode) && state.toolsExpanded) intent.tools = false;
	return intent;
}

export interface BlockTally {
	/** Thinking runs in the current branch. */
	thinking: number;
	/** Tool calls in the current branch. */
	tools: number;
}

/**
 * Count the collapsible blocks in a branch of the session.
 *
 * Entries are read defensively because a transcript also holds entries this
 * package never renders, and a count is not worth an exception.
 */
export function tallyBlocks(entries: readonly unknown[]): BlockTally {
	const tally: BlockTally = { thinking: 0, tools: 0 };
	for (const entry of entries) {
		const message = (entry as { message?: { role?: string; content?: unknown } } | undefined)?.message;
		if (!message || typeof message !== "object") continue;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as { type?: string }[]) {
			const type = (part as { type?: unknown } | undefined)?.type;
			if (type === "thinking") tally.thinking += 1;
			else if (type === "toolCall") tally.tools += 1;
		}
	}
	return tally;
}

export type BlockEffect = "expand-thinking" | "expand-tools" | "expand-all" | "collapse-all";

export interface BlockChoice {
	label: string;
	effect: BlockEffect;
}

export interface BlockViewState {
	thinkingHidden: boolean;
	toolsExpanded: boolean;
}

/**
 * The rows `/faiku blocks` offers: every group that is collapsed right now,
 * plus the two whole-transcript actions.
 *
 * Only collapsed groups are listed, so picking a row always expands and never
 * does the opposite of what its label says.
 */
export function blockChoices(tally: BlockTally, state: BlockViewState): BlockChoice[] {
	const choices: BlockChoice[] = [];
	if (tally.thinking > 0 && state.thinkingHidden) {
		choices.push({ label: `thinking       ${tally.thinking} block${tally.thinking === 1 ? "" : "s"} · collapsed`, effect: "expand-thinking" });
	}
	if (tally.tools > 0 && !state.toolsExpanded) {
		choices.push({ label: `tool output   ${tally.tools} call${tally.tools === 1 ? "" : "s"} · collapsed`, effect: "expand-tools" });
	}
	// Only worth a row when it does something the two above it do not.
	if (choices.length === 2) choices.push({ label: "everything    expand", effect: "expand-all" });
	choices.push({ label: "collapse all again", effect: "collapse-all" });
	return choices;
}

/** What each row says once it has been applied. */
export function describeEffect(effect: BlockEffect): string {
	switch (effect) {
		case "expand-thinking":
			return "Thinking blocks expanded; ctrl+t collapses them again.";
		case "expand-tools":
			return "Tool output expanded; ctrl+o collapses it again.";
		case "expand-all":
			return "Thinking blocks and tool output expanded.";
		case "collapse-all":
			return "Thinking blocks and tool output collapsed.";
	}
}

/** The one line `/faiku info` adds when thinking cannot be collapsed. */
export function describeDeferredCollapse(): string {
	return "thinking    needs the faiku box on (/faiku box on)";
}
