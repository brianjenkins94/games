/**
 * The pathology detector (W4, src/diag/pathology.ts): quiet where the pathing works, and catching what W0's traces
 * caught — and the census of every scenario's faults (oracle/census.ts) holding exactly, so a change to the pathing or
 * the detector that adds or clears one is a deliberate diff.
 */
import type { Command } from "../src/sim/command.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { rowsMap } from "../src/browser/maps.ts";
import { createPathologyDetector, STALL_TICKS } from "../src/diag/pathology.ts";
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

test("quiet on the old suite's clean scenarios but for stacking; W0's stuck pairs in pinch-corridor and production-rally caught — now settling short", () => {
	const faults = (name: string) => Object.keys(recorded[name]).filter((key) => !key.startsWith("stacked:")).sort();

	for (const scenario of SCENARIOS.filter((candidate) => !candidate.name.startsWith("random-") && !["pinch-corridor", "production-rally"].includes(candidate.name))) {
		assert.deepEqual(faults(scenario.name), [], scenario.name);
	}

	// W6 step 3: progress means beating the best so far, so they escalate and give up rather than jitter on. Unit 6 of
	// production-rally, whose rally point is taken, settles beside it (within a tile: not short).
	assert.deepEqual(faults("pinch-corridor"), ["settled-short:1", "settled-short:2", "stuck:1", "stuck:2"]);
	assert.deepEqual(faults("production-rally"), ["settled-short:5", "stuck:5", "stuck:6"]);
	assert.ok(Object.values(recorded).every((faults) => Object.keys(faults).every((key) => !key.startsWith("stalled:"))), "nothing stalls any more");
	// Every group moving together stacks (W6 step 0), the lone movers don't.
	assert.ok(Object.keys(recorded["group-open"]).every((key) => key.startsWith("stacked:")) && Object.keys(recorded["group-open"]).length > 0);
	assert.deepEqual(recorded["direction-SE"], {});
});

test("a unit going the long way round a wall is making progress along its route, not stalled", () => {
	// A wall between the footman and its goal, two tiles east, open only at the far end: 26 tiles down, round, and back
	// up — the straight line only grows for well over the stall window.
	const rows = Array.from({ "length": 30 }, (_, y) => Array.from({ "length": 12 }, (_, x) => (x === 6 && y < 29 ? "#" : ".")).join(""));
	const game = createGame(1, rowsMap(rows));
	const detector = createPathologyDetector();

	revealAll(game.world);
	game.initUnitIdCounter(0);

	const { MoveTarget, Position, UnitId } = game.world.components;
	const eid = game.spawnUnit(tileCenterFP(5), tileCenterFP(2), 0, undefined, unitTypeId("unit-footman"));
	const uid = UnitId.id[eid];
	const move: Command = { "type": CmdType.MOVE, "unitIds": [uid], "txFP": tileCenterFP(7), "tyFP": tileCenterFP(2) };
	const away = () => Math.abs(MoveTarget.tx[eid] - Position.x[eid]) + Math.abs(MoveTarget.ty[eid] - Position.y[eid]);
	let closest = Infinity;
	let closestAt = 0;
	let longestWithout = 0;
	let flagged: string | undefined;

	game.applyCommands([move]);

	for (let tick = 0; tick < 1500 && (tick === 0 || MoveTarget.active[eid] === 1); tick += 1) {
		game.step();
		flagged ??= detector.scan(game.world, tick === 0 ? [move] : []).get(uid);

		if (away() < closest - 8000) {
			[closest, closestAt] = [away(), tick];
		}

		longestWithout = Math.max(longestWithout, tick - closestAt);
	}

	assert.ok(longestWithout > STALL_TICKS, `the straight line went ${longestWithout} ticks without getting closer: longer than the stall window`);
	assert.equal(MoveTarget.active[eid], 0, "it got there");
	assert.equal(flagged, undefined);
});

test("stacked: two teammates moving on top of each other are flagged once they've stayed so", () => {
	const game = createGame(1, rowsMap(Array.from({ "length": 6 }, () => ".".repeat(40))));
	const detector = createPathologyDetector();

	revealAll(game.world);
	game.initUnitIdCounter(0);

	const { UnitId } = game.world.components;
	// Spawned overlapping (4 px apart), sent the same way one by one: nothing keeps movers apart, so they go stacked.
	const uids = [0, 4000].map((dx) => UnitId.id[game.spawnUnit(tileCenterFP(1) + dx, tileCenterFP(2), 0, undefined, unitTypeId("unit-footman"))]);
	const moves: Command[] = uids.map((uid) => ({ "type": CmdType.MOVE, "unitIds": [uid], "txFP": tileCenterFP(38), "tyFP": tileCenterFP(2) }));
	const seen: Record<number, number> = {};

	game.applyCommands(moves);

	for (let tick = 0; tick < 100; tick += 1) {
		game.step();

		for (const [uid, pathology] of detector.scan(game.world, tick === 0 ? moves : [])) {
			if (pathology === "stacked") {
				seen[uid] ??= tick;
			}
		}
	}

	assert.deepEqual(Object.keys(seen).map(Number).sort((a, b) => a - b), [...uids].sort((a, b) => a - b));
	assert.ok(Object.values(seen).every((tick) => tick >= 49), JSON.stringify(seen));
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
