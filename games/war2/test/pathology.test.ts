/**
 * The pathology detector (W4, src/diag/pathology.ts): quiet where the pathing works, and catching what W0's traces
 * caught — and the census of every scenario's faults (oracle/census.ts) holding exactly, so a change to the pathing or
 * the detector that adds or clears one is a deliberate diff.
 */
import type { Command } from "../src/sim/command.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { rowsMap } from "../src/browser/maps.ts";
import { createPathologyDetector } from "../src/diag/pathology.ts";
import { CmdType } from "../src/sim/command.ts";
import { tileCenterFP } from "../src/sim/components.ts";
import { createGame } from "../src/sim/game.ts";
import { unitTypeId } from "../src/sim/unitTypes.ts";
import { revealAll } from "../src/sim/vision.ts";
import { census, readCensus } from "./oracle/census.ts";
import { SCENARIOS } from "./oracle/scenarios.ts";

const recorded = readCensus();

for (const scenario of SCENARIOS) {
	test(`${scenario.name}: the detector finds what the census recorded`, () => {
		assert.deepEqual(census(scenario), recorded[scenario.name]);
	});
}

test("quiet on the old suite's clean scenarios; W0's stuck pairs in pinch-corridor and production-rally are caught as stalled", () => {
	for (const scenario of SCENARIOS.filter((candidate) => !candidate.name.startsWith("random-") && !["pinch-corridor", "production-rally"].includes(candidate.name))) {
		assert.deepEqual(recorded[scenario.name], {}, scenario.name);
	}

	assert.deepEqual(Object.keys(recorded["pinch-corridor"]).sort(), ["stalled:1", "stalled:2"]);
	assert.deepEqual(Object.keys(recorded["production-rally"]).sort(), ["stalled:5", "stalled:6"]);
});

test("give-up: a unit ordered alone somewhere it can't reach ends the tick idle, and is caught", () => {
	// A footman walled into a 1-tile cell, ordered out.
	const game = createGame(1, rowsMap(["#####...", "#.#.....", "###.....", "........"]));
	const detector = createPathologyDetector();

	revealAll(game.world);
	game.initUnitIdCounter(0);

	const uid = game.world.components.UnitId.id[game.spawnUnit(tileCenterFP(1), tileCenterFP(1), 0, undefined, unitTypeId("unit-footman"))];
	const move: Command = { "type": CmdType.MOVE, "unitIds": [uid], "txFP": tileCenterFP(6), "tyFP": tileCenterFP(3) };

	game.applyCommands([move]);
	game.step();
	assert.deepEqual([...detector.scan(game.world, [move])], [[uid, "give-up"]]);
});

test("a unit stopped by its player isn't settled-short, and a group in its slots isn't giving up", () => {
	const game = createGame(1, rowsMap(Array.from({ "length": 8 }, () => "........")));
	const detector = createPathologyDetector();

	revealAll(game.world);
	game.initUnitIdCounter(0);

	const { UnitId } = game.world.components;
	const uids = [1, 2].map((tile) => UnitId.id[game.spawnUnit(tileCenterFP(tile), tileCenterFP(1), 0, undefined, unitTypeId("unit-footman"))]);
	const go: Command = { "type": CmdType.MOVE, "unitIds": uids, "txFP": tileCenterFP(6), "tyFP": tileCenterFP(6) };
	const stop: Command = { "type": CmdType.STOP, "unitIds": uids };

	game.applyCommands([go]);
	game.step();
	assert.deepEqual([...detector.scan(game.world, [go])], []);

	for (let tick = 0; tick < 10; tick += 1) {
		game.step();
		detector.scan(game.world, []);
	}

	game.applyCommands([stop]);
	game.step();
	assert.deepEqual([...detector.scan(game.world, [stop])], [], "stopped where they stood, as told");
});
