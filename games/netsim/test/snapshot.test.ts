import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceTo, decodeUnit, encodeUnit, hashWorld, restoreWorld, spawnUnit, takeSnapshot, UNIT_FIELDS } from "../src/sim/index.ts";
import { makeWorld, randomScenario } from "./scenario.ts";

test("restore, then replay, equals continuous play", () => {
	for (const seed of [1, 2, 3, 4, 5]) {
		for (const at of [0, 1, 37, 120]) {
			const continuous = randomScenario(seed);
			const expected: number[] = [];

			advanceTo(continuous.world, continuous.log, 250, (world) => expected.push(hashWorld(world)));

			// Same scenario, snapshotted at `at` (units mid-move included) and restored into a fresh world.
			const paused = randomScenario(seed);

			advanceTo(paused.world, paused.log, at);

			const restored = restoreWorld(structuredClone(takeSnapshot(paused.world)));
			const actual = expected.slice(0, at);

			advanceTo(restored, paused.log, 250, (world) => actual.push(hashWorld(world)));
			assert.deepEqual(actual, expected, `seed ${seed}, snapshot at tick ${at}`);
		}
	}
});

test("a snapshot round-trips every field", () => {
	const { world, log } = randomScenario(9);

	advanceTo(world, log, 80);

	const restored = restoreWorld(takeSnapshot(world));

	assert.equal(hashWorld(restored), hashWorld(world));
	assert.deepEqual([...restored.units.values()], [...world.units.values()]);
	assert.equal(restored.tick, world.tick);
	assert.equal(restored.rng.state, world.rng.state);
	assert.equal(restored.nextUnitId, world.nextUnitId);
	assert.deepEqual(restored.config, world.config);
});

test("a unit encodes every UNIT_FIELDS field, and decodes back", () => {
	const world = makeWorld();
	const unit = spawnUnit(world, 1, 1234, 5678);

	Object.assign(unit, { "tx": 999, "ty": 888, "moving": 1 });

	const values = encodeUnit(unit);

	assert.equal(values.length, UNIT_FIELDS.length);
	assert.deepEqual(decodeUnit(values), unit);
	assert.deepEqual(Object.keys(unit).sort(), [...UNIT_FIELDS].sort(), "a Unit has exactly the UNIT_FIELDS fields");
	assert.throws(() => decodeUnit([1, 2, 3]), RangeError);
});

test("snapshots and restored worlds share nothing", () => {
	const { world, log } = randomScenario(11);
	const snapshot = takeSnapshot(world);
	const before = structuredClone(snapshot);

	advanceTo(world, log, 50);
	assert.deepEqual(snapshot, before, "stepping the world doesn't change its snapshot");

	const first = restoreWorld(snapshot);
	const second = restoreWorld(snapshot);

	advanceTo(first, log, 50);
	assert.deepEqual(takeSnapshot(second), before, "stepping one restore doesn't change the other");
	assert.deepEqual(snapshot, before, "or the snapshot");
});
