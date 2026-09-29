import { test } from "node:test";
import assert from "node:assert/strict";

import {
	blockChoices,
	parseCollapseMode,
	planCollapse,
	tallyBlocks,
	wantsThinking,
	wantsTools,
} from "../lib/collapse.ts";

const visible = { hideThinkingBlock: false, toolsExpanded: true, flippedThinking: false };

test("the mode key only accepts the four documented modes", () => {
	assert.equal(parseCollapseMode("thinking", "all"), "thinking");
	assert.equal(parseCollapseMode("off", "all"), "off");
	assert.equal(parseCollapseMode("nonsense", "all"), "all");
	assert.equal(parseCollapseMode(undefined, "tools"), "tools");
	assert.equal(parseCollapseMode(["all"], "all"), "all");
});

test("a mode says which groups it owns", () => {
	assert.equal(wantsThinking("all"), true);
	assert.equal(wantsThinking("thinking"), true);
	assert.equal(wantsThinking("tools"), false);
	assert.equal(wantsThinking("off"), false);
	assert.equal(wantsTools("all"), true);
	assert.equal(wantsTools("tools"), true);
	assert.equal(wantsThinking("off"), false);
	assert.equal(wantsTools("off"), false);
});

test("`all` collapses both groups when both are open", () => {
	assert.deepEqual(planCollapse("all", visible), { thinking: true, tools: false });
});

test("nothing is flipped twice", () => {
	// `flippedThinking: false` says pi's own setting is what hid them.
	const collapsed = { hideThinkingBlock: true, toolsExpanded: false, flippedThinking: false };
	assert.deepEqual(planCollapse("all", collapsed), {});
	assert.deepEqual(planCollapse("thinking", collapsed), {});
	assert.deepEqual(planCollapse("tools", collapsed), {});
});

test("a mode collapses only the group it owns", () => {
	assert.deepEqual(planCollapse("thinking", visible), { thinking: true });
	assert.deepEqual(planCollapse("tools", visible), { tools: false });
});

test("a mode never expands, and `off` never touches anything", () => {
	assert.deepEqual(planCollapse("off", visible), {});
	// Thinking already hidden, expanded tool output: still nothing to do, because
	// expanding is the user's call, not the configuration's.
	assert.deepEqual(planCollapse("off", { hideThinkingBlock: true, toolsExpanded: true, flippedThinking: false }), {});
});

test("turning the mode off puts back the thinking state faiku itself changed", () => {
	assert.deepEqual(planCollapse("off", { hideThinkingBlock: true, toolsExpanded: false, flippedThinking: true }), { thinking: false });
	// Hidden by pi's own setting, not by us: left alone.
	assert.deepEqual(planCollapse("off", { hideThinkingBlock: true, toolsExpanded: false, flippedThinking: false }), {});
	// Dropping the mode that owns thinking also puts it back.
	assert.deepEqual(planCollapse("tools", { hideThinkingBlock: true, toolsExpanded: true, flippedThinking: true }), { thinking: false, tools: false });
});

test("the branch is counted for thinking runs and tool calls only", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "thinking", thinking: "hmm again" },
					{ type: "text", text: "sure" },
					{ type: "toolCall", id: "1", name: "bash", arguments: {} },
				],
			},
		},
		{ type: "message", message: { role: "toolResult", toolCallId: "1", toolName: "bash", content: [] } },
		{ type: "thinking_level_change", thinkingLevel: "high" },
		undefined,
	];
	assert.deepEqual(tallyBlocks(entries), { thinking: 2, tools: 1 });
	assert.deepEqual(tallyBlocks([]), { thinking: 0, tools: 0 });
	assert.deepEqual(tallyBlocks([{ type: "message" }, { message: null }, 42]), { thinking: 0, tools: 0 });
});

test("the picker offers only what is collapsed, plus the whole-transcript rows", () => {
	const tally = { thinking: 3, tools: 12 };
	const labels = (state) => blockChoices(tally, state).map((choice) => choice.label);

	assert.deepEqual(labels({ thinkingHidden: true, toolsExpanded: false }), [
		"thinking       3 blocks · collapsed",
		"tool output   12 calls · collapsed",
		"everything    expand",
		"collapse all again",
	]);
	assert.deepEqual(labels({ thinkingHidden: true, toolsExpanded: true }), [
		"thinking       3 blocks · collapsed",
		"collapse all again",
	]);
	// Nothing collapsed: the only honest row is the one that collapses again.
	assert.deepEqual(labels({ thinkingHidden: false, toolsExpanded: true }), ["collapse all again"]);
});

test("the picker counts in the singular and drops groups the branch has none of", () => {
	const choices = blockChoices({ thinking: 1, tools: 0 }, { thinkingHidden: true, toolsExpanded: false });
	assert.deepEqual(choices, [
		{ label: "thinking       1 block · collapsed", effect: "expand-thinking" },
		{ label: "collapse all again", effect: "collapse-all" },
	]);
	assert.deepEqual(blockChoices({ thinking: 0, tools: 0 }, { thinkingHidden: true, toolsExpanded: false }), [
		{ label: "collapse all again", effect: "collapse-all" },
	]);
});

test("each row carries the effect it applies", () => {
	const effects = blockChoices({ thinking: 2, tools: 1 }, { thinkingHidden: true, toolsExpanded: false }).map((choice) => choice.effect);
	assert.deepEqual(effects, ["expand-thinking", "expand-tools", "expand-all", "collapse-all"]);
});
