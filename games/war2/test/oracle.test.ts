/**
 * The oracle (W0, see MIGRATION.md): every scenario's recorded trace, replayed on both sims. The old one proves the
 * traces are deterministic and don't depend on run order; the new one (W1's) has to agree tick for tick — except where
 * it deviates on purpose (deviations.ts: held to its own trace, and the deviation has to be real).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runLegacy } from "./oracle/legacy.ts";
import { runSim } from "./oracle/sim.ts";
import { SCENARIOS } from "./oracle/scenarios.ts";
import { DEVIATIONS } from "./oracle/deviations.ts";
import { divergence, readTrace, record } from "./oracle/trace.ts";

for (const scenario of SCENARIOS) {
	const deviation = DEVIATIONS[scenario.name];

	test(`${scenario.name} plays as recorded — on the old sim, and the new${deviation === undefined ? "" : ` (deviates: ${deviation})`}`, () => {
		assert.equal(divergence(readTrace(scenario.name), record(scenario, runLegacy)), undefined, "the old sim");
		assert.equal(divergence(readTrace(scenario.name, "sim"), record(scenario, runSim)), undefined, "the new sim");

		if (deviation !== undefined) {
			assert.notEqual(divergence(readTrace(scenario.name), readTrace(scenario.name, "sim")), undefined, "a listed deviation still deviates (else take it off the list)");
		}
	});
}

test("no scenario depends on what ran before it (the old sim keeps its state in module globals)", () => {
	for (const scenario of [...SCENARIOS].reverse()) {
		assert.equal(divergence(readTrace(scenario.name), record(scenario, runLegacy)), undefined);
	}
});
