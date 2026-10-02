/**
 * The pathology detector (W4, src/diag/pathology.ts): quiet where the pathing works, and catching what W0's traces
 * caught — and the census of every scenario's faults (oracle/census.ts) holding exactly, so a change to the pathing or
 * the detector that adds or clears one is a deliberate diff.
 */
import type { Command } from "../src/sim/command.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { rowsMap } from "../src/browser/maps.ts";
import { createPathologyDetector, STACK_TICKS, STALL_TICKS } from "../src/diag/pathology.ts";
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

test("quiet on the old suite's clean scenarios; W0's stuck pairs in pinch-corridor and production-rally now arrive", () => {
	const faults = (name: string) => Object.keys(recorded[name]).filter((key) => !key.startsWith("stacked:")).sort();

	for (const scenario of SCENARIOS.filter((candidate) => !candidate.name.startsWith("random-") && !["pinch-corridor", "production-rally"].includes(candidate.name))) {
		assert.deepEqual(faults(scenario.name), [], scenario.name);
	}

	// W6 step 3: progress means beating the best so far, so they escalate rather than jitter on. Step 4 (one rule for
	// what blocks a mover): production-rally's two, whose rally point is taken, settle beside it (within a tile: not
	// short). Step 5 (local planning round parked units): pinch-corridor's two go round the teammate parked in their way
	// and arrive — slowed, so flagged stuck on the way, but not giving up.
	// Step 6: unit 6 queues at the gap behind 3 and 5, shuffling across a tile edge while it waits its turn. Step 7: a
	// slot taken when a unit gets near it is swapped for the nearest free one — pinch-corridor's three sent to one point,
	// production-rally's two at a rally point already taken — so nobody grinds against a parked unit any more.
	assert.deepEqual(faults("pinch-corridor"), ["oscillating:6"]);
	assert.deepEqual(faults("production-rally"), []);
	assert.ok(Object.values(recorded).every((faults) => Object.keys(faults).every((key) => !key.startsWith("stalled:"))), "nothing stalls any more");
	// Every group moving together stacked (W6 step 0); travelling as a block and queueing where it narrows, none does now
	// (step 6).
	assert.ok(Object.values(recorded).every((faults) => Object.keys(faults).every((key) => !key.startsWith("stacked:"))), "nothing travels stacked");
	assert.deepEqual(recorded["group-open"], {});
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
	// The detector only reads the world (the sim no longer lets a group travel stacked — W6 step 6): two units held 4 px
	// apart, both "moving".
	const game = createGame(1, rowsMap(Array.from({ "length": 6 }, () => ".".repeat(40))));
	const detector = createPathologyDetector();

	game.initUnitIdCounter(0);

	const { MoveTarget, UnitId } = game.world.components;
	const eids = [0, 4000].map((dx) => game.spawnUnit(tileCenterFP(1) + dx, tileCenterFP(2), 0, undefined, unitTypeId("unit-footman")));
	const seen: Record<number, number> = {};

	for (const eid of eids) {
		[MoveTarget.active[eid], MoveTarget.tx[eid], MoveTarget.ty[eid]] = [1, tileCenterFP(38), tileCenterFP(2)];
	}

	for (let tick = 0; tick < 60; tick += 1) {
		game.world.tick += 1;

		for (const [uid, pathology] of detector.scan(game.world, [])) {
			if (pathology === "stacked") {
				seen[uid] ??= tick;
			}
		}
	}

	assert.deepEqual(Object.keys(seen).map(Number).sort((a, b) => a - b), eids.map((eid) => UnitId.id[eid]).sort((a, b) => a - b));
	assert.ok(Object.values(seen).every((tick) => tick === STACK_TICKS - 1), JSON.stringify(seen));
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

test("a stall beside a moving teammate is a jam (a queue not clearing); alone, it's a stall", () => {
	// The detector only reads the world: two units held where they are, both "moving", far from their targets.
	for (const [apart, expected] of [[32, "jammed"], [200, "stalled"]] as const) {
		const game = createGame(1, rowsMap(Array.from({ "length": 8 }, () => ".".repeat(16))));
		const detector = createPathologyDetector();

		game.initUnitIdCounter(0);

		const { MoveTarget, UnitId } = game.world.components;
		const [a, b] = [2, 2 + apart / 32].map((tile) => game.spawnUnit(tileCenterFP(tile), tileCenterFP(4), 0, undefined, unitTypeId("unit-footman")));

		for (const eid of [a, b]) {
			[MoveTarget.active[eid], MoveTarget.tx[eid], MoveTarget.ty[eid]] = [1, tileCenterFP(15), tileCenterFP(0)];
		}

		let seen: string | undefined;

		for (let tick = 0; tick <= STALL_TICKS; tick += 1) {
			game.world.tick += 1;
			seen = detector.scan(game.world, []).get(UnitId.id[a]) ?? seen;
		}

		assert.equal(seen, expected, `${apart} px apart`);
	}
});

