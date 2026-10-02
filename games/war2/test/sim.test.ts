/**
 * The sim's state contract (W1): one field list (SIM_FIELDS) drives what a snapshot carries, what a spawn resets, and
 * what the world hash covers — so a snapshot restores everything, a recycled entity starts clean, and the hash sees
 * every change. (One world per realm: creating one resets the sim's module state, so each test snapshots before it
 * creates the world it restores into.)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SIM_FIELDS, tileCenterFP, UnitId } from "../src/sim/components.ts";
import { CmdType } from "../src/sim/command.ts";
import { createGame } from "../src/sim/game.ts";
import { revealAll } from "../src/sim/vision.ts";
import { worldHash } from "../src/sim/snapshot.ts";

function open(size = 12) {
	const game = createGame(1, { "gids": Array.from({ "length": size * size }, () => 1), "mapW": size, "mapH": size, "terrainArr": [0, 0] });

	revealAll();
	game.initUnitIdCounter(0);

	return game;
}

/** Every sim field of the entity with stable id `uid`, by name. */
function fieldsOf(game: ReturnType<typeof createGame>, uid: number): Record<string, number> {
	const eid = game.eidForUnitId(uid)!;

	return Object.fromEntries(SIM_FIELDS.map(([name, column]) => [name, column[eid]!]));
}

test("a snapshot restores every sim field, by stable id", () => {
	const game = open();
	const uids = [2, 5, 8].map((tile) => UnitId.id[game.spawnUnit(tileCenterFP(tile), tileCenterFP(tile), 0)]!);

	// Give every field of every unit a distinct value (small enough for the narrowest column).
	for (const [index, uid] of uids.entries()) {
		const eid = game.eidForUnitId(uid)!;

		for (const [fieldIndex, [name, column]] of SIM_FIELDS.entries()) {
			if (name !== "UnitId.id") {
				column[eid] = 1 + ((index * 7 + fieldIndex) % 90);
			}
		}
	}

	const before = uids.map((uid) => fieldsOf(game, uid));
	const snapshot = game.takeSnapshot();
	const restored = open();

	restored.applySnapshot(snapshot);
	assert.deepEqual(uids.map((uid) => fieldsOf(restored, uid)), before);
});

test("a unit spawned on a recycled entity starts clean — no corridor or goal left from the last one", () => {
	const game = open();
	const first = game.spawnUnit(tileCenterFP(2), tileCenterFP(2), 0);

	for (const [name, column] of SIM_FIELDS) {
		if (name.startsWith("Path.")) {
			column[first] = 7;
		}
	}

	game.despawnUnit(first);

	const second = game.spawnUnit(tileCenterFP(4), tileCenterFP(4), 0);

	assert.equal(second, first, "bitecs recycled the entity");
	assert.deepEqual(SIM_FIELDS.filter(([name]) => name.startsWith("Path.wp") || name === "Path.goalTx" || name === "Path.goalTy").map(([name, column]) => [name, column[second]]), [["Path.goalTx", 0], ["Path.goalTy", 0], ["Path.wpActive", 0], ["Path.wpFromTx", 0], ["Path.wpFromTy", 0], ["Path.wpTx", 0], ["Path.wpTy", 0]]);
});

test("the repeat-move memo survives a restore, keyed by stable ids", () => {
	const game = open();
	const uids = [3, 4].map((tile) => UnitId.id[game.spawnUnit(tileCenterFP(tile), tileCenterFP(6), 0)]!);

	game.applyCommands([{ "type": CmdType.MOVE, "unitIds": uids, "txFP": tileCenterFP(9), "tyFP": tileCenterFP(9) }]);

	const snapshot = game.takeSnapshot();
	const restored = open();

	restored.applySnapshot(snapshot);
	assert.deepEqual(restored.world.lastMove, game.world.lastMove);
	assert.ok(restored.world.lastMove !== undefined && Object.keys(restored.world.lastMove).length > 0);
});

test("the world hash covers every sim field — and comes back the same after a restore", () => {
	const game = open();
	const eid = game.spawnUnit(tileCenterFP(3), tileCenterFP(3), 0);
	const hash = worldHash(game.world);

	for (const [name, column] of SIM_FIELDS) {
		if (name === "UnitId.id") {
			continue;
		}

		const kept = column[eid]!;

		column[eid] = kept + 1;
		assert.notEqual(worldHash(game.world), hash, `a change to ${name} changes the hash`);
		column[eid] = kept;
	}

	// Snapshot first: creating a world resets the sim's module state (one world per realm), and the snapshot reads it.
	const snapshot = game.takeSnapshot();
	const restored = open();

	restored.applySnapshot(snapshot);
	assert.equal(worldHash(restored.world), hash);
});
