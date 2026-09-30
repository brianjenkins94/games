import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { applyCommand, spawnUnit, tiles, validateCommand } from "../src/sim/index.ts";
import { makeWorld } from "./scenario.ts";

function setup() {
	const world = makeWorld();
	const mine = spawnUnit(world, 0, tiles(1), tiles(1));
	const theirs = spawnUnit(world, 1, tiles(8), tiles(8));

	return { "world": world, "mine": mine, "theirs": theirs };
}

test("malformed commands are refused, never thrown", () => {
	const { world, mine } = setup();
	const malformed: unknown[] = [
		undefined,
		null,
		42,
		"move",
		{},
		{ "type": "move" },
		{ "type": "move", "units": [] },
		{ "type": "move", "units": "1" },
		{ "type": "move", "units": [1.5], "x": 0, "y": 0 },
		{ "type": "move", "units": [mine.id], "x": Number.NaN, "y": 0 },
		{ "type": "move", "units": [mine.id], "x": 0, "y": Number.POSITIVE_INFINITY },
		{ "type": "move", "units": [mine.id], "x": "10", "y": 0 },
		{ "type": "move", "units": [mine.id], "x": 1.5, "y": 0 },
		{ "type": "move", "units": [mine.id] },
		{ "type": "teleport", "units": [mine.id], "x": 0, "y": 0 }
	];

	for (const command of malformed) {
		assert.deepEqual(validateCommand(world, 0, command), { "ok": false, "reason": "malformed" }, inspect(command));
	}
});

test("commands must name existing units the team owns, and stay on the map", () => {
	const { world, mine, theirs } = setup();

	assert.deepEqual(validateCommand(world, 0, { "type": "stop", "units": [999] }), { "ok": false, "reason": "unknown-unit" });
	assert.deepEqual(validateCommand(world, 0, { "type": "stop", "units": [mine.id, theirs.id] }), { "ok": false, "reason": "not-owner" });
	assert.deepEqual(validateCommand(world, 0, { "type": "move", "units": [mine.id], "x": -1, "y": 0 }), { "ok": false, "reason": "out-of-bounds" });
	assert.deepEqual(validateCommand(world, 0, { "type": "move", "units": [mine.id], "x": 0, "y": tiles(world.config.height) }), { "ok": false, "reason": "out-of-bounds" });
});

test("a refused command changes nothing", () => {
	const { world, theirs } = setup();
	const before = structuredClone(theirs);

	assert.equal(applyCommand(world, 0, { "type": "move", "units": [theirs.id], "x": 0, "y": 0 }).ok, false);
	assert.deepEqual(theirs, before);
});

test("move sets the target; stop drops it; moving to where you are is a no-op", () => {
	const { world, mine } = setup();

	assert.equal(applyCommand(world, 0, { "type": "move", "units": [mine.id], "x": tiles(5), "y": tiles(2) }).ok, true);
	assert.deepEqual([mine.tx, mine.ty, mine.moving], [tiles(5), tiles(2), 1]);

	assert.equal(applyCommand(world, 0, { "type": "stop", "units": [mine.id] }).ok, true);
	assert.deepEqual([mine.tx, mine.ty, mine.moving], [mine.x, mine.y, 0]);

	applyCommand(world, 0, { "type": "move", "units": [mine.id], "x": mine.x, "y": mine.y });
	assert.equal(mine.moving, 0);
});

test("validation normalizes: the returned command is a fresh copy", () => {
	const { world, mine } = setup();
	const input = { "type": "move", "units": [mine.id], "x": tiles(3), "y": tiles(3), "extra": "ignored" };
	const result = validateCommand(world, 0, input);

	assert.ok(result.ok);
	assert.deepEqual(result.command, { "type": "move", "units": [mine.id], "x": tiles(3), "y": tiles(3) });
	assert.notEqual(result.command.units, input.units);
});
