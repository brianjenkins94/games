/**
 * The snapshot contract (W1): a sim restored from a snapshot plays on exactly as the one it was taken from. Each
 * scenario runs restoring itself — snapshot, then a fresh sim from nothing but that snapshot — every EVERY ticks, and
 * every tick must still match the recorded trace. A field the snapshot leaves out (the old sim's pinch-corridor
 * waypoints, its formation memo) shows up as the first tick the restoring run parts from it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SCENARIOS } from "./oracle/scenarios.ts";
import { runSim } from "./oracle/sim.ts";
import { divergence, readTrace, record } from "./oracle/trace.ts";

const EVERY = 7;

for (const scenario of SCENARIOS) {
	test(`${scenario.name}: restored from a snapshot every ${EVERY} ticks, it plays as recorded`, () => {
		assert.equal(divergence(readTrace(scenario.name, "sim"), record(scenario, (run, onTick) => { runSim(run, onTick, { "every": EVERY }); })), undefined);
	});
}
