/**
 * Record the oracle's traces: the old sim's, for every scenario (or those named), into traces/<name>.json — or, with
 * `--sim`, the new sim's, for the scenarios where it deviates on purpose (deviations.ts), into traces/sim/<name>.json.
 *
 *     npm run record [-- [--sim] <scenario> …]
 *     npm run record -- --census
 *     npm run record -- --incident <scenario>
 *
 * `--census` records the pathology census instead (census.ts): what the detector finds in every scenario, on the new
 * sim — after a deliberate change to the pathing or the detector. `--incident` saves a scenario's first incident as a
 * fixture in test/incidents/ (census.ts firstIncident); `--reaches <scenario> <uid> <tick>` saves that moment as a fixture
 * expecting the unit to reach its goal — a fixed incident kept fixed (census.ts reachesFixture).
 *
 * Re-record the old sim's only to add or change a scenario: they're its behaviour, and the new sim is held to them. The
 * new sim's only after a deliberate change, listed in deviations.ts with why.
 */
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import { census, CENSUS_FILE, firstIncident, reachesFixture } from "./census.ts";
import { DEVIATIONS } from "./deviations.ts";
import { runLegacy } from "./legacy.ts";
import { runSim } from "./sim.ts";
import { SCENARIOS } from "./scenarios.ts";
import { record, TRACES, traceFile } from "./trace.ts";

if (process.argv.includes("--census")) {
	const found = Object.fromEntries(SCENARIOS.map((scenario) => [scenario.name, census(scenario)]));

	fs.writeFileSync(CENSUS_FILE, JSON.stringify(found, undefined, "\t") + "\n");
	console.log(Object.entries(found).map(([name, faults]) => `${name}: ${Object.keys(faults).length}`).join("\n"));
	process.exit(0);
}

if (process.argv.includes("--incident")) {
	const name = process.argv[process.argv.indexOf("--incident") + 1];
	const fixture = firstIncident(SCENARIOS.find((scenario) => scenario.name === name)!);

	if (fixture === undefined) {
		console.log(`${name}: no incident`);
		process.exit(1);
	}

	const file = path.resolve(import.meta.dirname, "../incidents", `${fixture.id}.json`);

	await fs.mkdir(path.dirname(file), { "recursive": true });
	fs.writeFileSync(file, JSON.stringify(fixture) + "\n");
	console.log(`${fixture.label}: ticks ${fixture.baseTick}→${fixture.flagTick}, ${fixture.commands.length} commands, focus ${JSON.stringify(fixture.focus)} → ${path.relative(process.cwd(), file)}`);
	process.exit(0);
}

if (process.argv.includes("--reaches")) {
	const [name, uid, tick] = process.argv.slice(process.argv.indexOf("--reaches") + 1);
	const fixture = reachesFixture(SCENARIOS.find((scenario) => scenario.name === name)!, Number(uid), Number(tick));
	const file = path.resolve(import.meta.dirname, "../incidents", `${fixture!.id}.json`);

	await fs.mkdir(path.dirname(file), { "recursive": true });
	fs.writeFileSync(file, JSON.stringify(fixture) + "\n");
	console.log(`${fixture!.label}: ticks ${fixture!.baseTick}→${fixture!.flagTick}, ${fixture!.commands.length} commands, expects ${JSON.stringify(fixture!.expect)} → ${path.relative(process.cwd(), file)}`);
	process.exit(0);
}

const of = process.argv.includes("--sim") ? "sim" : "legacy";
const wanted = process.argv.slice(2).filter((arg) => arg !== "--sim");

await fs.mkdir(path.join(TRACES, "sim"), { "recursive": true });

for (const scenario of SCENARIOS.filter((candidate) => (wanted.length === 0 || wanted.includes(candidate.name)) && (of === "legacy" || candidate.name in DEVIATIONS))) {
	const started = performance.now();
	const trace = record(scenario, of === "sim" ? runSim : runLegacy);
	const final = trace.checkpoints[scenario.ticks]!;
	const moving = final.units.filter((unit) => unit.target !== undefined).length;

	fs.writeFileSync(traceFile(scenario.name, of), JSON.stringify(trace) + "\n");
	console.log(`${scenario.name}: ${scenario.ticks} ticks, ${final.units.length} units (${moving} still moving at the end), ${Math.round(performance.now() - started)}ms`);
}
