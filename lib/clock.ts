/**
 * The session timer.
 *
 * Time since the session started is the wrong number: most of a session is
 * spent waiting for a person to type. The clock is therefore a stopwatch that
 * runs only while the agent works, driven by the agent's own start and end
 * events, and sampled with an injected clock so it is testable.
 */

export interface WorkClock {
	/** True while the agent is working and the total is climbing. */
	readonly running: boolean;
	/** The total so far, including the run in progress. Reading never moves it. */
	elapsed(now?: number): number;
	/** Begin a run. A run already in progress is left alone, not restarted. */
	start(now?: number): void;
	/** End the run. A clock that is not running is left alone. */
	stop(now?: number): void;
	/** Forget the total, for a new session. */
	reset(now?: number): void;
}

export function createWorkClock(now: () => number = Date.now): WorkClock {
	let workedMs = 0;
	/** When the run in progress began; meaningless while stopped. */
	let since = now();
	let running = false;

	/** The distance from the run's start, which must never be negative. */
	const runMs = (at: number): number => Math.max(0, at - since);
	const elapsed = (at: number): number => workedMs + (running ? runMs(at) : 0);

	return {
		get running() {
			return running;
		},
		elapsed: (at = now()) => elapsed(at),
		start(at = now()) {
			if (running) return;
			running = true;
			since = at;
		},
		stop(at = now()) {
			if (!running) return;
			workedMs += runMs(at);
			running = false;
		},
		reset(at = now()) {
			workedMs = 0;
			since = at;
			running = false;
		},
	};
}
