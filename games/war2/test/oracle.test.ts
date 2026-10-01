/**
 * The oracle (W0, see MIGRATION.md): every scenario's recorded trace, replayed. Today it runs the old sim — proving
 * the traces are deterministic and don't depend on run order; in W1 the new sim runs here instead, and has to agree
 * tick for tick (a deliberate behaviour change shows up here, to be documented, never silently).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runLegacy } from "./oracle/legacy.ts";
import { SCENARIOS } from "./oracle/scenarios.ts";
import { divergence, readTrace, record } from "./oracle/trace.ts";

for (const scenario of SCENARIOS) {
	test(`${scenario.name} plays as recorded`, () => {
		assert.equal(divergence(readTrace(scenario.name), record(scenario, runLegacy)), undefined);
	});
}

test("no scenario depends on what ran before it (the old sim keeps its state in module globals)", () => {
	for (const scenario of [...SCENARIOS].reverse()) {
		assert.equal(divergence(readTrace(scenario.name), record(scenario, runLegacy)), undefined);
	}
});
