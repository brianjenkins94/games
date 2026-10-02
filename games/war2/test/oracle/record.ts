/**
 * Record the oracle's traces: the old sim's, for every scenario (or those named), into traces/<name>.json — or, with
 * `--sim`, the new sim's, for the scenarios where it deviates on purpose (deviations.ts), into traces/w1/<name>.json.
 *
 *     npm run record [-- [--sim] <scenario> …]
 *
 * Re-record the old sim's only to add or change a scenario: they're its behaviour, and the new sim is held to them. The
 * new sim's only after a deliberate change, listed in deviations.ts with why.
 */
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import { DEVIATIONS } from "./deviations.ts";
import { runLegacy } from "./legacy.ts";
import { runSim } from "./sim.ts";
import { SCENARIOS } from "./scenarios.ts";
import { record, TRACES, traceFile } from "./trace.ts";

const of = process.argv.includes("--sim") ? "sim" : "legacy";
const wanted = process.argv.slice(2).filter((arg) => arg !== "--sim");

await fs.mkdir(path.join(TRACES, "w1"), { "recursive": true });

for (const scenario of SCENARIOS.filter((candidate) => (wanted.length === 0 || wanted.includes(candidate.name)) && (of === "legacy" || candidate.name in DEVIATIONS))) {
	const started = performance.now();
	const trace = record(scenario, of === "sim" ? runSim : runLegacy);
	const final = trace.checkpoints[scenario.ticks]!;
	const moving = final.units.filter((unit) => unit.target !== undefined).length;

	fs.writeFileSync(traceFile(scenario.name, of), JSON.stringify(trace) + "\n");
	console.log(`${scenario.name}: ${scenario.ticks} ticks, ${final.units.length} units (${moving} still moving at the end), ${Math.round(performance.now() - started)}ms`);
}
