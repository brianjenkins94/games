/**
 * A recorded trace: a scenario's digest at every tick (the state after setup, then after each step), and its full
 * canonical state every CHECKPOINT ticks and at the end — enough to find the first tick two sims part, and to see how.
 */
import type { CanonicalState } from "./canonical.ts";
import type { Scenario } from "./scenarios.ts";
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import { digest } from "./canonical.ts";

export const CHECKPOINT = 100;
export const TRACES = path.resolve(import.meta.dirname, "traces");

export interface Trace {
	"scenario": string;
	"ticks": number;
	"digests": string[];
	"checkpoints": Record<number, CanonicalState>;
}

/** Record a run: `run` hands each tick's state to the callback it's given. */
export function record(scenario: Scenario, run: (scenario: Scenario, onTick: (state: CanonicalState) => void) => void): Trace {
	const trace: Trace = { "scenario": scenario.name, "ticks": scenario.ticks, "digests": [], "checkpoints": {} };
	let last: CanonicalState | undefined;

	run(scenario, (state) => {
		trace.digests.push(digest(state));

		if (state.tick % CHECKPOINT === 0) {
			trace.checkpoints[state.tick] = state;
		}

		last = state;
	});

	if (last !== undefined) {
		trace.checkpoints[last.tick] = last;
	}

	return trace;
}

export function traceFile(name: string): string {
	return path.join(TRACES, name + ".json");
}

export function readTrace(name: string): Trace {
	return JSON.parse(fs.readFileSync(traceFile(name))) as Trace;
}

/** Compare a run against a recorded trace: undefined if they agree every tick, else where they first part. */
export function divergence(recorded: Trace, run: Trace): string | undefined {
	const length = Math.max(recorded.digests.length, run.digests.length);

	for (let tick = 0; tick < length; tick += 1) {
		if (recorded.digests[tick] !== run.digests[tick]) {
			const checkpoint = Math.floor(tick / CHECKPOINT) * CHECKPOINT;

			return `${recorded.scenario}: first differs at tick ${tick} (recorded ${recorded.digests[tick]}, ran ${run.digests[tick]}); the last agreeing checkpoint is tick ${checkpoint}`;
		}
	}

	return undefined;
}
