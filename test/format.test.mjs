import { test } from "node:test";
import assert from "node:assert/strict";

import { formatCost, formatDuration, formatInt, formatPercent, formatTokens, shortenPath } from "../lib/format.ts";

test("formatInt groups thousands with spaces", () => {
	assert.equal(formatInt(0), "0");
	assert.equal(formatInt(142), "142");
	assert.equal(formatInt(1284), "1 284");
	assert.equal(formatInt(1234567), "1 234 567");
	assert.equal(formatInt(-4200), "-4 200");
	assert.equal(formatInt(Number.NaN), "0");
});

test("formatTokens shortens only where it helps", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(842), "842");
	assert.equal(formatTokens(18400), "18.4k");
	assert.equal(formatTokens(184_000), "184k");
	assert.equal(formatTokens(2_400_000), "2.4M");
	assert.equal(formatTokens(-5), "0");
});

test("formatCost keeps small spends readable", () => {
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(0.0042), "$0.0042");
	assert.equal(formatCost(0.42), "$0.42");
	assert.equal(formatCost(12.5), "$12.50");
});

test("formatPercent rounds to whole points", () => {
	assert.equal(formatPercent(12.4), "12%");
	assert.equal(formatPercent(12.6), "13%");
	assert.equal(formatPercent(100), "100%");
});

test("formatDuration picks the largest unit that still carries information", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(4500), "4s");
	assert.equal(formatDuration(59_999), "59s");
	assert.equal(formatDuration(60_000), "1m00s");
	assert.equal(formatDuration(252_000), "4m12s");
	assert.equal(formatDuration(3_600_000), "1h00m");
	assert.equal(formatDuration(7_500_000), "2h05m");
	assert.equal(formatDuration(-1), "0s");
});

test("shortenPath keeps the last two segments", () => {
	assert.equal(shortenPath("/Users/adam/code/pi"), "code/pi");
	assert.equal(shortenPath("/Users/adam/code/pi/"), "code/pi");
	assert.equal(shortenPath("/pi"), "pi");
	assert.equal(shortenPath(""), "");
	assert.equal(shortenPath("C:\\work\\repo", 1), "repo");
});
