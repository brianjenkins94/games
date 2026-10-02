/**
 * The pathology census (W4): every scenario run on the new sim with the pathology detector (src/diag/pathology.ts)
 * watching, and what it finds — each unit's kind of trouble and the tick it first showed — recorded beside the traces
 * (`traces/pathologies.json`, `npm run record -- --census`). The pathing is carried as-is until its rewrite (see
 * MIGRATION.md), so the census is its known faults; a change that adds or clears one shows up as a diff, on purpose.
 */
import type { Command } from "../../src/sim/command.ts";
import type { Scenario } from "./scenarios.ts";
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import type { Fixture } from "../../src/diag/recorder.ts";
import { createPathologyDetector } from "../../src/diag/pathology.ts";
import { createRecorder } from "../../src/diag/recorder.ts";
import { fpToTile } from "../../src/sim/components.ts";
import { mapInfo } from "./scenarios.ts";
import { runSim } from "./sim.ts";
import { TRACES } from "./trace.ts";

export const CENSUS_FILE = path.join(TRACES, "pathologies.json");

/** `kind:uid` → the first tick the detector flagged it, over the scenario's run. */
export function census(scenario: Scenario): Record<string, number> {
	const detector = createPathologyDetector();
	const seen: Record<string, number> = {};

	runSim(scenario, (state, game, applied) => {
		for (const [uid, kind] of detector.scan(game.world, applied as Command[])) {
			seen[`${kind}:${uid}`] ??= state.tick;
		}
	});

	return seen;
}

export function readCensus(): Record<string, Record<string, number>> {
	return JSON.parse(fs.readFileSync(CENSUS_FILE)) as Record<string, Record<string, number>>;
}

/** The scenario's first incident, as the referee's recorder would capture it (auto-flagged by the detector), saved as
 *  a fixture — what `save_incident_test` makes from a live match, made here from a scenario: the incident corpus's seed
 *  (`npm run record -- --incident <scenario>`). */
export function firstIncident(scenario: Scenario): Fixture | undefined {
	const recorder = createRecorder();
	const teamOf = new Map<unknown, number>();
	let fixture: Fixture | undefined;

	for (const command of scenario.script) {
		teamOf.set(command.at, command.team ?? 0);
	}

	runSim(scenario, (state, game, applied) => {
		if (fixture !== undefined || state.tick === 0) {
			return;
		}

		recorder.observe(game.world, (applied as Command[]).map((command) => ({ "team": (command as { "team"?: number }).team ?? 0, "command": command })));

		const [first] = recorder.incidents();

		if (first !== undefined) {
			fixture = recorder.fixture(first.id, { "map": mapInfo(scenario.map), "seed": scenario.seed, "teams": 2 });
			fixture!.id = `${scenario.name}-${first.focus?.pathology ?? "incident"}`;
			fixture!.label = `${scenario.name}: ${first.label}`;
		}
	});

	return fixture;
}

/** A moment of a scenario captured as a fixture that expects its focus unit to reach its goal — an incident that's
 *  been fixed, kept as one that must stay fixed (`npm run record -- --reaches <scenario> <uid> <tick>`): flagged by hand
 *  at `tick` on `uid`, which must then come within a tile of where it's going in the replay's settle budget. */
export function reachesFixture(scenario: Scenario, uid: number, tick: number): Fixture | undefined {
	const recorder = createRecorder();
	let fixture: Fixture | undefined;

	runSim(scenario, (state, game, applied) => {
		if (fixture !== undefined || state.tick === 0) {
			return;
		}

		recorder.observe(game.world, (applied as Command[]).map((command) => ({ "team": (command as { "team"?: number }).team ?? 0, "command": command })));

		if (state.tick === tick) {
			const { MoveTarget } = game.world.components;
			const eid = game.world.eidOf.get(uid)!;
			const incident = recorder.flag(game.world, `${scenario.name}: uid${uid} reaches its goal`, { "uid": uid, "pathology": "settled-short", "goal": [fpToTile(MoveTarget.tx[eid]), fpToTile(MoveTarget.ty[eid])] });

			fixture = recorder.fixture(incident.id, { "map": mapInfo(scenario.map), "seed": scenario.seed, "teams": 2 });
			fixture!.id = `${scenario.name}-uid${uid}-reaches`;
			fixture!.expect = { "reachesGoal": true, "settleBudget": 300 };
		}
	});

	return fixture;
}

