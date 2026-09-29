import { test } from "node:test";
import assert from "node:assert/strict";

import {
	charCount,
	collectInfo,
	contextLabel,
	costLabel,
	emptyInfo,
	locationLabel,
	sessionTotals,
	shortModel,
	tokenLabel,
} from "../lib/info.ts";

const assistant = (usage) => ({ type: "message", message: { role: "assistant", usage } });
const user = { type: "message", message: { role: "user" } };
const entry = { type: "custom", customType: "note" };

test("usage is summed over the assistant messages on the branch", () => {
	const totals = sessionTotals([
		entry,
		user,
		assistant({ input: 100, output: 20, cost: { total: 0.01 } }),
		assistant({ input: 50, output: 5, cost: { total: 0.02 } }),
		// A tool result carries no usage and must not be counted.
		{ type: "message", message: { role: "toolResult" } },
	]);
	assert.deepEqual(totals, { tokensIn: 150, tokensOut: 25, cost: 0.03 });
});

test("a session with no priced model reports no cost rather than a free one", () => {
	const totals = sessionTotals([assistant({ input: 10, output: 1 })]);
	assert.equal(totals.cost, 0);
	assert.equal(costLabel({ ...emptyInfo(), cost: totals.cost }), undefined);
});

test("an empty branch is zero, not undefined", () => {
	assert.deepEqual(sessionTotals([]), { tokensIn: 0, tokensOut: 0, cost: 0 });
});

/** The slice of ExtensionContext that collectInfo reads. */
function fakeContext(overrides = {}) {
	return {
		cwd: "/Users/adam/code/FaikuTheme",
		model: { id: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
		thinkingLevel: "high",
		isIdle: () => false,
		getContextUsage: () => ({ tokens: 18_400, contextWindow: 200_000, percent: 12.4 }),
		sessionManager: {
			getBranch: () => [assistant({ input: 4200, output: 980, cost: { total: 0.42 } })],
		},
		...overrides,
	};
}

test("collectInfo takes one snapshot of everything the rails show", () => {
	const info = collectInfo(fakeContext(), {
		sessionStart: 1_000,
		now: () => 254_000,
		branch: "feat/theme",
		dirty: { changed: 2, untracked: 1 },
	});
	assert.equal(info.model, "anthropic/claude-sonnet-4-5");
	assert.equal(info.provider, "anthropic");
	assert.equal(info.thinking, "high");
	assert.equal(info.contextPercent, 12.4);
	assert.equal(info.contextTokens, 18_400);
	assert.equal(info.tokensIn, 4200);
	assert.equal(info.tokensOut, 980);
	assert.equal(info.cost, 0.42);
	assert.equal(info.branch, "feat/theme");
	assert.equal(info.dirtyChanged, 2);
	assert.equal(info.dirtyUntracked, 1);
	assert.equal(info.elapsedMs, 253_000);
	assert.equal(info.idle, false);
});

test("a context pi cannot measure is null, never zero", () => {
	const info = collectInfo(fakeContext({ getContextUsage: () => undefined }), { sessionStart: 0, now: () => 0 });
	assert.equal(info.contextPercent, null);
	assert.equal(info.contextTokens, null);
	assert.equal(contextLabel(info), undefined);
});

test("a session with no model is reported without one", () => {
	const info = collectInfo(fakeContext({ model: undefined }), { sessionStart: 0, now: () => 0 });
	assert.equal(info.model, undefined);
	assert.equal(shortModel(info.model), undefined);
});

test("the clock never runs backwards", () => {
	const info = collectInfo(fakeContext(), { sessionStart: 10_000, now: () => 0 });
	assert.equal(info.elapsedMs, 0);
});

test("labels are short enough for a rail", () => {
	const info = { ...emptyInfo(), model: "anthropic/claude-sonnet-4-5", contextPercent: 12.4, contextTokens: 18_400, tokensIn: 4200, tokensOut: 980, cost: 0.42, cwd: "/Users/adam/code/FaikuTheme" };
	assert.equal(shortModel(info.model), "claude-sonnet-4-5");
	assert.equal(contextLabel(info), "12% · 18.4k");
	assert.equal(locationLabel(info), "code/FaikuTheme");
	assert.equal(tokenLabel(info), "↑4.2k ↓980");
	assert.equal(costLabel(info), "$0.42");
	assert.equal(charCount(1284), "1 284");
});

test("a context percentage without a token count is still shown", () => {
	assert.equal(contextLabel({ ...emptyInfo(), contextPercent: 42 }), "42%");
	assert.equal(tokenLabel(emptyInfo()), undefined);
	assert.equal(locationLabel(emptyInfo()), undefined);
});
