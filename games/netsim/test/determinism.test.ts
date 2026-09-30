import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, advanceTo, hashWorld } from "../src/sim/index.ts";
import { randomScenario } from "./scenario.ts";

function hashes(seed: number, ticks: number): number[] {
	const { world, log } = randomScenario(seed);
	const out: number[] = [];

	advanceTo(world, log, ticks, (current) => out.push(hashWorld(current)));

	return out;
}

test("the same seed and commands reproduce the same state, tick for tick", () => {
	for (const seed of [1, 2, 3, 0xC0FFEE]) {
		assert.deepEqual(hashes(seed, 250), hashes(seed, 250));
	}
});

test("different seeds diverge", () => {
	assert.notDeepEqual(hashes(1, 50), hashes(2, 50));
});

test("worlds are independent instances: interleaved stepping matches stepping each alone", () => {
	const first = randomScenario(7);
	const second = randomScenario(8);
	const firstHashes: number[] = [];
	const secondHashes: number[] = [];

	// Step two worlds alternately in one realm. Shared (module-global) state would make each perturb the other.
	for (let tick = 0; tick < 250; tick += 1) {
		advance(first.world, first.log);
		firstHashes.push(hashWorld(first.world));
		advance(second.world, second.log);
		secondHashes.push(hashWorld(second.world));
	}

	assert.deepEqual(firstHashes, hashes(7, 250));
	assert.deepEqual(secondHashes, hashes(8, 250));
});
