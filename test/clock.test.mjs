import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorkClock } from "../lib/clock.ts";

test("an idle session accumulates nothing", () => {
	const clock = createWorkClock();
	assert.equal(clock.running, false);
	assert.equal(clock.elapsed(60_000), 0);
});

test("only the runs between start and stop are counted", () => {
	const clock = createWorkClock();
	clock.start(5_000);
	assert.equal(clock.elapsed(8_000), 3_000);
	clock.stop(8_000);
	assert.equal(clock.elapsed(8_000), 3_000);
	// Forty-two seconds of the agent thinking are not work.
	assert.equal(clock.elapsed(50_000), 3_000);
	clock.start(50_000);
	clock.stop(55_000);
	assert.equal(clock.elapsed(900_000), 8_000);
});

test("a run in progress is reported before it ends", () => {
	const clock = createWorkClock();
	clock.start(1_000);
	assert.equal(clock.running, true);
	assert.equal(clock.elapsed(4_000), 3_000);
	clock.stop(4_000);
	assert.equal(clock.elapsed(4_000), 3_000);
});

test("reading the clock does not move it", () => {
	const clock = createWorkClock();
	clock.start(1_000);
	clock.elapsed(2_000);
	clock.elapsed(3_000);
	assert.equal(clock.elapsed(4_000), 3_000);
});

test("a start inside a run does not restart it", () => {
	const clock = createWorkClock();
	clock.start(1_000);
	clock.start(2_000);
	assert.equal(clock.elapsed(3_000), 2_000);
});

test("a stop outside a run is a no-op", () => {
	const clock = createWorkClock();
	clock.stop(5_000);
	assert.equal(clock.running, false);
	assert.equal(clock.elapsed(9_000), 0);
});

test("a clock that jumps backwards never runs backwards", () => {
	const clock = createWorkClock();
	clock.start(10_000);
	assert.equal(clock.elapsed(2_000), 0);
	clock.stop(2_000);
	assert.equal(clock.elapsed(20_000), 0);
});

test("reset is a new session, not a new total", () => {
	const clock = createWorkClock();
	clock.start(0);
	clock.stop(30_000);
	assert.equal(clock.elapsed(30_000), 30_000);
	clock.reset();
	assert.equal(clock.running, false);
	assert.equal(clock.elapsed(60_000), 0);
	clock.start(60_000);
	assert.equal(clock.elapsed(62_000), 2_000);
});
