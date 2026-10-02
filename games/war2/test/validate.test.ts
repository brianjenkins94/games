/**
 * Command validation (W1): what a client may send, checked as untrusted data — every rejection reachable, every
 * accepted command normalized, nothing thrown. Plus the two guards beside it: the stable type table and the entity cap.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import unitsJson from "../src/assets/units.json" with { "type": "json" };
import unitTypeIds from "../src/assets/unitTypeIds.json" with { "type": "json" };
import { CmdType } from "../src/sim/command.ts";
import { MAX_ENTITIES, tileCenterFP } from "../src/sim/components.ts";
import { createGame } from "../src/sim/game.ts";
import { unitTypeId, unitTypeName } from "../src/sim/unitTypes.ts";
import { MAX_LIVE_UNITS, MAX_QUEUED_ORDERS, MAX_QUEUED_PRODUCTION, validateCommand } from "../src/sim/validate.ts";
import { revealAll } from "../src/sim/vision.ts";

const SIZE = 12;
const EDGE = SIZE * 32 * 1000;

/** A 12×12 open map: team 0 has two footmen and a finished barracks, team 1 one footman and a barracks. */
function setup() {
	const game = createGame(1, { "gids": Array.from({ "length": SIZE * SIZE }, () => 1), "mapW": SIZE, "mapH": SIZE, "terrainArr": [0, 0] });

	revealAll(game.world);
	game.initUnitIdCounter(0);

	const uid = (eid: number) => game.world.components.UnitId.id[eid]!;
	const footman = unitTypeId("unit-footman");
	const barracksType = unitTypeId("unit-human-barracks");
	const mine = [uid(game.spawnUnit(tileCenterFP(1), tileCenterFP(1), 0, undefined, footman)), uid(game.spawnUnit(tileCenterFP(2), tileCenterFP(1), 0, undefined, footman))];
	const theirs = uid(game.spawnUnit(tileCenterFP(10), tileCenterFP(10), 1, undefined, footman));
	const barracksEid = game.spawnBuilding(4, 4, 0, barracksType);
	const enemyBarracks = uid(game.spawnBuilding(8, 0, 1, barracksType));

	return { "barracks": uid(barracksEid), "enemyBarracks": enemyBarracks, "footman": footman, "game": game, "mine": mine, "theirs": theirs, "validate": (input: unknown) => validateCommand(game.world, 0, input) };
}

function reason(result: ReturnType<typeof validateCommand>): string {
	return "reason" in result ? result.reason : "ok";
}

test("MOVE and STOP: the issuer's own mobile units, each once, to a point on the map", () => {
	const { barracks, mine, theirs, validate } = setup();
	const to = tileCenterFP(6);

	assert.deepEqual(validate({ "type": CmdType.MOVE, "unitIds": mine, "txFP": to, "tyFP": to, "extra": "dropped" }), { "ok": true, "command": { "type": CmdType.MOVE, "unitIds": mine, "txFP": to, "tyFP": to, "queue": false } });
	assert.deepEqual(validate({ "type": CmdType.STOP, "unitIds": mine, "queue": true }), { "ok": true, "command": { "type": CmdType.STOP, "unitIds": mine, "queue": true } });

	const cases: [unknown, string][] = [
		[{ "type": CmdType.MOVE, "unitIds": [], "txFP": to, "tyFP": to }, "malformed"],
		[{ "type": CmdType.MOVE, "unitIds": [mine[0], mine[0]], "txFP": to, "tyFP": to }, "malformed"],
		[{ "type": CmdType.MOVE, "unitIds": [1.5], "txFP": to, "tyFP": to }, "malformed"],
		[{ "type": CmdType.MOVE, "unitIds": "1", "txFP": to, "tyFP": to }, "malformed"],
		[{ "type": CmdType.MOVE, "unitIds": Array.from({ "length": MAX_LIVE_UNITS + 1 }, (_, i) => i), "txFP": to, "tyFP": to }, "malformed"],
		[{ "type": CmdType.MOVE, "unitIds": mine, "txFP": Number.NaN, "tyFP": to }, "malformed"],
		[{ "type": CmdType.MOVE, "unitIds": mine, "txFP": to }, "malformed"],
		[{ "type": CmdType.MOVE, "unitIds": mine, "txFP": to, "tyFP": to, "queue": 1 }, "malformed"],
		[{ "type": CmdType.MOVE, "unitIds": [9999], "txFP": to, "tyFP": to }, "unknown-unit"],
		[{ "type": CmdType.MOVE, "unitIds": [mine[0], theirs], "txFP": to, "tyFP": to }, "not-owner"],
		[{ "type": CmdType.MOVE, "unitIds": [barracks], "txFP": to, "tyFP": to }, "wrong-type"],
		[{ "type": CmdType.MOVE, "unitIds": mine, "txFP": -1, "tyFP": to }, "out-of-bounds"],
		[{ "type": CmdType.MOVE, "unitIds": mine, "txFP": to, "tyFP": EDGE }, "out-of-bounds"],
		[{ "type": CmdType.STOP, "unitIds": [theirs] }, "not-owner"]
	];

	for (const [input, expected] of cases) {
		assert.equal(reason(validate(input)), expected, JSON.stringify(input));
	}
});

test("a shift-queued order is refused once the unit has MAX_QUEUED_ORDERS waiting", () => {
	const { game, mine, validate } = setup();
	const move = { "type": CmdType.MOVE, "unitIds": [mine[0]], "txFP": tileCenterFP(6), "tyFP": tileCenterFP(6), "queue": true };

	game.world.orders = { [mine[0]!]: Array.from({ "length": MAX_QUEUED_ORDERS }, () => ({ "kind": "move" as const, "txFP": 0, "tyFP": 0 })) };
	assert.equal(reason(validate(move)), "full");
	assert.equal(reason(validate({ ...move, "queue": false })), "ok", "a replacing order is always fine");
});

test("BUILD: a building type, whole footprint on the map, the issuer's team, under the cap", () => {
	const { footman, validate } = setup();
	const farm = unitTypeId("unit-farm");

	assert.deepEqual(validate({ "type": CmdType.BUILD, "typeId": farm, "tileX": 0, "tileY": 10 }), { "ok": true, "command": { "type": CmdType.BUILD, "typeId": farm, "team": 0, "tileX": 0, "tileY": 10 } });

	const cases: [unknown, string][] = [
		[{ "type": CmdType.BUILD, "typeId": farm, "tileX": 0, "tileY": 10, "team": 1 }, "not-owner"],
		[{ "type": CmdType.BUILD, "typeId": footman, "tileX": 0, "tileY": 10 }, "wrong-type"],
		[{ "type": CmdType.BUILD, "typeId": 0, "tileX": 0, "tileY": 10 }, "wrong-type"],
		[{ "type": CmdType.BUILD, "typeId": farm, "tileX": "0", "tileY": 10 }, "malformed"],
		[{ "type": CmdType.BUILD, "typeId": farm, "tileX": -1, "tileY": 10 }, "out-of-bounds"],
		[{ "type": CmdType.BUILD, "typeId": farm, "tileX": SIZE - 1, "tileY": 0 }, "out-of-bounds"]
	];

	for (const [input, expected] of cases) {
		assert.equal(reason(validate(input)), expected, JSON.stringify(input));
	}
});

test("PRODUCE, CANCEL_PRODUCE, SET_RALLY: the issuer's own building, a type it trains, a real index, a point on the map", () => {
	const { barracks, enemyBarracks, footman, game, mine, validate } = setup();
	const to = tileCenterFP(6);

	assert.deepEqual(validate({ "type": CmdType.PRODUCE, "buildingUid": barracks, "productTypeId": footman }), { "ok": true, "command": { "type": CmdType.PRODUCE, "buildingUid": barracks, "productTypeId": footman, "team": 0 } });
	assert.deepEqual(validate({ "type": CmdType.CANCEL_PRODUCE, "buildingUid": barracks, "index": 0 }), { "ok": true, "command": { "type": CmdType.CANCEL_PRODUCE, "buildingUid": barracks, "index": 0, "team": 0 } });
	assert.deepEqual(validate({ "type": CmdType.SET_RALLY, "buildingUid": barracks, "txFP": to, "tyFP": to }), { "ok": true, "command": { "type": CmdType.SET_RALLY, "buildingUid": barracks, "txFP": to, "tyFP": to, "team": 0 } });

	const cases: [unknown, string][] = [
		[{ "type": CmdType.PRODUCE, "buildingUid": enemyBarracks, "productTypeId": footman }, "not-owner"],
		[{ "type": CmdType.PRODUCE, "buildingUid": mine[0], "productTypeId": footman }, "wrong-type"],
		[{ "type": CmdType.PRODUCE, "buildingUid": 9999, "productTypeId": footman }, "unknown-unit"],
		[{ "type": CmdType.PRODUCE, "buildingUid": null, "productTypeId": footman }, "malformed"],
		[{ "type": CmdType.PRODUCE, "buildingUid": barracks, "productTypeId": unitTypeId("unit-peasant") }, "wrong-type"],
		[{ "type": CmdType.PRODUCE, "buildingUid": barracks, "productTypeId": unitTypeId("unit-farm") }, "wrong-type"],
		[{ "type": CmdType.PRODUCE, "buildingUid": barracks, "productTypeId": 60000 }, "wrong-type"],
		[{ "type": CmdType.PRODUCE, "buildingUid": barracks, "productTypeId": Infinity }, "malformed"],
		// The old validator let a NaN index through, and cancelProduction then dropped the queue's head.
		[{ "type": CmdType.CANCEL_PRODUCE, "buildingUid": barracks, "index": Number.NaN }, "malformed"],
		[{ "type": CmdType.CANCEL_PRODUCE, "buildingUid": barracks, "index": -1 }, "malformed"],
		[{ "type": CmdType.SET_RALLY, "buildingUid": barracks, "txFP": to, "tyFP": -5 }, "out-of-bounds"],
		[{ "type": CmdType.SET_RALLY, "buildingUid": barracks, "txFP": to }, "malformed"]
	];

	for (const [input, expected] of cases) {
		assert.equal(reason(validate(input)), expected, JSON.stringify(input));
	}

	game.world.production = { [barracks]: { "queue": Array.from({ "length": MAX_QUEUED_PRODUCTION }, () => footman), "ticksLeft": 1, "ticksTotal": 1 } };
	assert.equal(reason(validate({ "type": CmdType.PRODUCE, "buildingUid": barracks, "productTypeId": footman })), "full");
});

test("SPAWN and SPEED aren't a client's; anything else isn't a command — and nothing throws", () => {
	const { validate } = setup();

	assert.equal(reason(validate({ "type": CmdType.SPAWN, "xFP": 0, "yFP": 0, "team": 0, "typeId": 1 })), "not-allowed");
	assert.equal(reason(validate({ "type": CmdType.SPEED, "speed": 0 })), "not-allowed");

	for (const [index, input] of [null, undefined, 1, "move", [], {}, { "type": 99 }, { "type": "1" }, Object.create(null), { "type": CmdType.MOVE, "unitIds": [{}] }].entries()) {
		assert.equal(reason(validate(input)), "malformed", `case ${index}`);
	}
});

test("a team at MAX_LIVE_UNITS can't build or train more", () => {
	const { barracks, footman, game, validate } = setup();

	for (let i = 0; i < MAX_LIVE_UNITS; i++) {
		game.spawnUnit(tileCenterFP(i % SIZE), tileCenterFP(11), 0, undefined, footman);
	}

	assert.equal(reason(validate({ "type": CmdType.BUILD, "typeId": unitTypeId("unit-farm"), "tileX": 0, "tileY": 10 })), "full");
	assert.equal(reason(validate({ "type": CmdType.PRODUCE, "buildingUid": barracks, "productTypeId": footman })), "full");
});

test("a full world spawns nothing: past MAX_ENTITIES, spawns return -1 and leave state alone", () => {
	const { footman, game } = setup();
	const live = () => game.unitEids().length;

	while (live() < MAX_ENTITIES) {
		assert.notEqual(game.spawnUnit(tileCenterFP(0), tileCenterFP(0), 0, undefined, footman), -1);
	}

	const next = game.takeSnapshot().nextUnitId;

	assert.equal(game.spawnUnit(tileCenterFP(0), tileCenterFP(0), 0, undefined, footman), -1);
	assert.equal(game.spawnBuilding(0, 10, 0, unitTypeId("unit-farm")), -1);
	assert.equal(live(), MAX_ENTITIES);
	assert.equal(game.takeSnapshot().nextUnitId, next, "no stable id spent");
});

test("unit type ids come from the append-only table: every units.json type is in it once, ids unchanged", () => {
	assert.equal(new Set(unitTypeIds).size, unitTypeIds.length, "no name twice");

	for (const name of Object.keys(unitsJson)) {
		assert.ok(unitTypeIds.includes(name), `${name} has an id (append it to unitTypeIds.json)`);
	}

	for (const [index, name] of unitTypeIds.entries()) {
		assert.equal(unitTypeId(name), index + 1);
		assert.equal(unitTypeName(index + 1), name);
	}

	// Ids snapshots and commands already carry (the sorted-keys ids they had before the table): pinned, so a reorder fails.
	assert.deepEqual(["unit-footman", "unit-peasant", "unit-farm"].map(unitTypeId), [41, 104, 37]);
});
