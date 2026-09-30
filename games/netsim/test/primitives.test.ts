import assert from "node:assert/strict";
import { test } from "node:test";
import { approxDistance, createRng, hashUnits, hashWorld, nextInt, nextU32, spawnUnit, tiles, UNIT_FIELDS } from "../src/sim/index.ts";
import { makeWorld } from "./scenario.ts";

test("the RNG is seeded, deterministic, and never stuck at zero", () => {
	const first = createRng(42);
	const second = createRng(42);

	for (let index = 0; index < 1000; index += 1) {
		assert.equal(nextU32(first), nextU32(second));
	}

	const zero = createRng(0);

	assert.notEqual(zero.state, 0);
	assert.notEqual(nextU32(zero), 0);
});

test("nextInt stays in [low, high) and refuses an empty range", () => {
	const rng = createRng(7);

	for (let index = 0; index < 1000; index += 1) {
		const value = nextInt(rng, -3, 4);

		assert.ok(Number.isInteger(value) && value >= -3 && value < 4);
	}

	assert.throws(() => nextInt(rng, 5, 5), RangeError);
	assert.throws(() => nextInt(rng, 6, 5), RangeError);
});

test("approxDistance is exact on axes and within 8% on diagonals", () => {
	assert.equal(approxDistance(0, 0), 0);
	assert.equal(approxDistance(-7000, 0), 7000);
	assert.equal(approxDistance(0, 3000), 3000);

	for (const [dx, dy] of [[1000, 1000], [3000, -4000], [-5000, 1200]]) {
		const exact = Math.hypot(dx, dy);

		assert.ok(Math.abs(approxDistance(dx, dy) - exact) / exact < 0.08, `${dx},${dy}`);
	}
});

test("changing any unit field changes the world hash", () => {
	const world = makeWorld();
	const unit = spawnUnit(world, 1, tiles(4), tiles(4));
	const base = hashWorld(world);

	for (const field of UNIT_FIELDS) {
		const original = unit[field];

		unit[field] = original + 1;
		assert.notEqual(hashWorld(world), base, field);
		unit[field] = original;
	}

	assert.equal(hashWorld(world), base);
});

test("the world hash covers tick, RNG and the id counter, and hashes large and negative values distinctly", () => {
	const world = makeWorld();
	const base = hashWorld(world);

	world.tick += 1;
	assert.notEqual(hashWorld(world), base);
	world.tick -= 1;
	nextU32(world.rng);
	assert.notEqual(hashWorld(world), base);

	const other = makeWorld();

	other.nextUnitId += 1;
	assert.notEqual(hashWorld(other), hashWorld(makeWorld()));

	const units = (value: number) => [{ "id": 1, "team": 0, "x": value, "y": 0, "tx": 0, "ty": 0, "moving": 0 }];

	assert.notEqual(hashUnits(units(-1)), hashUnits(units(0xFFFFFFFF)));
	assert.notEqual(hashUnits(units(2 ** 32)), hashUnits(units(0)));
});

test("spawnUnit refuses unknown teams and off-map positions", () => {
	const world = makeWorld();

	assert.throws(() => spawnUnit(world, 2, 0, 0), RangeError);
	assert.throws(() => spawnUnit(world, -1, 0, 0), RangeError);
	assert.throws(() => spawnUnit(world, 0, tiles(32), 0), RangeError);
	assert.throws(() => spawnUnit(world, 0, 0.5, 0), RangeError);
	assert.equal(world.units.size, 0);
});
