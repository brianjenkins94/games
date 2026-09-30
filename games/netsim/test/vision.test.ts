import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnUnit, tiles, visibleUnits } from "../src/sim/index.ts";
import { makeWorld } from "./scenario.ts";

test("a team always sees its own units", () => {
	const world = makeWorld();
	const far = spawnUnit(world, 0, tiles(1), tiles(1));
	const farther = spawnUnit(world, 0, tiles(30), tiles(30));

	assert.deepEqual(visibleUnits(world, 0).map((unit) => unit.id), [far.id, farther.id]);
});

test("an enemy is visible within sight, including exactly at the edge, and not beyond", () => {
	const world = makeWorld({ "sight": tiles(5) });
	const viewer = spawnUnit(world, 0, tiles(10), tiles(10));
	const inside = spawnUnit(world, 1, tiles(13), tiles(10));
	const edge = spawnUnit(world, 1, tiles(10), tiles(15));
	const beyond = spawnUnit(world, 1, tiles(10), tiles(15) + 1);

	const seen = visibleUnits(world, 0).map((unit) => unit.id);

	assert.deepEqual(seen, [viewer.id, inside.id, edge.id]);
	assert.ok(!seen.includes(beyond.id));
});

test("a team with no units sees nothing", () => {
	const world = makeWorld({ "teams": 3 });

	spawnUnit(world, 0, tiles(1), tiles(1));
	assert.deepEqual(visibleUnits(world, 2), []);
});

test("vision is by team: each team's view is its own", () => {
	const world = makeWorld({ "sight": tiles(3) });
	const scout = spawnUnit(world, 0, tiles(5), tiles(5));
	const near = spawnUnit(world, 1, tiles(7), tiles(5));
	const far = spawnUnit(world, 1, tiles(20), tiles(20));

	assert.deepEqual(visibleUnits(world, 0).map((unit) => unit.id), [scout.id, near.id]);
	assert.deepEqual(visibleUnits(world, 1).map((unit) => unit.id), [scout.id, near.id, far.id]);
});
