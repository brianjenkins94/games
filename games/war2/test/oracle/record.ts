/**
 * Record the oracle's traces from the old sim: every scenario (or those named), into traces/<name>.json.
 *
 *     npm run record [-- <scenario> …]
 *
 * Re-record only to add or change a scenario: the traces are the old sim's behaviour, and W1's sim is held to them.
 */
import * as fs from "@brianjenkins94/util/fs";
import { runLegacy } from "./legacy.ts";
import { SCENARIOS } from "./scenarios.ts";
import { record, TRACES, traceFile } from "./trace.ts";

const wanted = process.argv.slice(2);

await fs.mkdir(TRACES, { "recursive": true });

for (const scenario of SCENARIOS.filter((candidate) => wanted.length === 0 || wanted.includes(candidate.name))) {
	const started = performance.now();
	const trace = record(scenario, runLegacy);
	const final = trace.checkpoints[scenario.ticks]!;
	const moving = final.units.filter((unit) => unit.target !== undefined).length;

	fs.writeFileSync(traceFile(scenario.name), JSON.stringify(trace) + "\n");
	console.log(`${scenario.name}: ${scenario.ticks} ticks, ${final.units.length} units (${moving} still moving at the end), ${Math.round(performance.now() - started)}ms`);
}
