/**
 * The sim's state contract (W1): one field list (each world's `fields`) drives what a snapshot carries, what a spawn
 * resets, and what the world hash covers — so a snapshot restores everything, a recycled entity starts clean, and the
 * hash sees every change. And all of a world's state is its own: worlds side by side don't touch each other.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";
import { CmdType } from "../src/sim/command.ts";
import { tileCenterFP } from "../src/sim/components.ts";
import { createGame } from "../src/sim/game.ts";
import { worldHash } from "../src/sim/snapshot.ts";
import { revealAll } from "../src/sim/vision.ts";

function open(size = 12) {
	const game = createGame(1, { "gids": Array.from({ "length": size * size }, () => 1), "mapW": size, "mapH": size, "terrainArr": [0, 0] });

	revealAll(game.world);
	game.initUnitIdCounter(0);

	return game;
}

/** Every sim field of the entity with stable id `uid`, by name. */
function fieldsOf(game: ReturnType<typeof createGame>, uid: number): Record<string, number> {
	const eid = game.eidForUnitId(uid)!;

	return Object.fromEntries(game.world.fields.map(([name, column]) => [name, column[eid]!]));
}

test("a snapshot restores every sim field, by stable id", () => {
	const game = open();
	const { UnitId } = game.world.components;
	const uids = [2, 5, 8].map((tile) => UnitId.id[game.spawnUnit(tileCenterFP(tile), tileCenterFP(tile), 0)]!);

	// Give every field of every unit a distinct value (small enough for the narrowest column).
	for (const [index, uid] of uids.entries()) {
		const eid = game.eidForUnitId(uid)!;

		for (const [fieldIndex, [name, column]] of game.world.fields.entries()) {
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

	for (const [name, column] of game.world.fields) {
		if (name.startsWith("Path.")) {
			column[first] = 7;
		}
	}

	game.despawnUnit(first);

	const second = game.spawnUnit(tileCenterFP(4), tileCenterFP(4), 0);

	assert.equal(second, first, "bitecs recycled the entity");
	assert.deepEqual(game.world.fields.filter(([name]) => name.startsWith("Path.wp") || name === "Path.goalTx" || name === "Path.goalTy").map(([name, column]) => [name, column[second]]), [["Path.goalTx", 0], ["Path.goalTy", 0], ["Path.wpActive", 0], ["Path.wpFromTx", 0], ["Path.wpFromTy", 0], ["Path.wpTx", 0], ["Path.wpTy", 0]]);
});

test("the repeat-move memo survives a restore, keyed by stable ids", () => {
	const game = open();
	const { UnitId } = game.world.components;
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

	for (const [name, column] of game.world.fields) {
		if (name === "UnitId.id") {
			continue;
		}

		const kept = column[eid]!;

		column[eid] = kept + 1;
		assert.notEqual(worldHash(game.world), hash, `a change to ${name} changes the hash`);
		column[eid] = kept;
	}

	const snapshot = game.takeSnapshot();
	const restored = open();

	restored.applySnapshot(snapshot);
	assert.equal(worldHash(restored.world), hash);
});

test("worlds side by side share nothing: two games interleaved tick by tick play as each does alone", () => {
	const run = (game: ReturnType<typeof open>, tile: number): void => {
		const { UnitId } = game.world.components;
		const uids = [tile, tile + 1].map((t) => UnitId.id[game.spawnUnit(tileCenterFP(t), tileCenterFP(t), 0)]!);

		game.applyCommands([{ "type": CmdType.MOVE, "unitIds": uids, "txFP": tileCenterFP(9), "tyFP": tileCenterFP(9) }]);
	};
	const alone = [2, 5].map((tile) => {
		const game = open();

		run(game, tile);

		for (let tick = 0; tick < 60; tick += 1) {
			game.step();
		}

		return worldHash(game.world);
	});
	const [a, b] = [open(), open()];

	run(a, 2);
	run(b, 5);

	for (let tick = 0; tick < 60; tick += 1) {
		a.step();
		b.step();
	}

	assert.deepEqual([worldHash(a.world), worldHash(b.world)], alone);
	assert.notEqual(alone[0], alone[1], "the two games differ, so sharing would show");
});

test("the sim keeps no state of its own: no module-level variables, only constant tables", () => {
	// Everything mutable lives on the world (world.ts). These are lookup tables, built once and never written.
	const TABLES = new Set(["CmdType", "LOCAL_FIELDS", "DIR_DX", "DIR_DY", "DIR_COST", "_names", "_ids"]);
	const root = path.resolve(import.meta.dirname, "../src/sim");
	const found: string[] = [];

	for (const file of fs.readdirSync(root, { "recursive": true }).map(String).filter((name) => name.endsWith(".ts"))) {
		for (const [index, line] of fs.readFileSync(path.join(root, file)).split("\n").entries()) {
			const variable = /^(?:export )?(?:let|var) (\w+)/u.exec(line)?.[1];
			const container = /^(?:export )?const (\w+)(?:: [^=]+)? = (?:new |\[|\{)/u.exec(line)?.[1];

			if (variable !== undefined || (container !== undefined && !TABLES.has(container))) {
				found.push(`${file}:${index + 1} ${variable ?? container}`);
			}
		}
	}

	assert.deepEqual(found, [], "module state: put it on the world");
});
