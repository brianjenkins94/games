import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCommand, approxDistance, spawnUnit, stepWorld, tiles } from "../src/sim/index.ts";
import { makeWorld } from "./scenario.ts";

function ticksToArrive(from: [number, number], to: [number, number]): { "ticks": number; "unit": { "x": number; "y": number; "moving": number } } {
	const world = makeWorld();
	const unit = spawnUnit(world, 0, ...from);

	applyCommand(world, 0, { "type": "move", "units": [unit.id], "x": to[0], "y": to[1] });

	let ticks = 0;

	while (unit.moving === 1 && ticks < 10_000) {
		stepWorld(world);
		ticks += 1;
	}

	return { "ticks": ticks, "unit": unit };
}

test("a unit arrives exactly on its target, in distance / speed ticks", () => {
	const speed = 125;
	const cases: [[number, number], [number, number]][] = [
		[[tiles(2), tiles(2)], [tiles(6), tiles(2)]], // east
		[[tiles(6), tiles(6)], [tiles(6), tiles(1)]], // north
		[[tiles(1), tiles(1)], [tiles(9), tiles(9)]], // diagonal
		[[tiles(10), tiles(3)], [tiles(4), tiles(7)]], // off-axis
		[[500, 500], [501, 499]] // less than one step
	];

	for (const [from, to] of cases) {
		const { ticks, unit } = ticksToArrive(from, to);
		const distance = approxDistance(to[0] - from[0], to[1] - from[1]);

		assert.deepEqual([unit.x, unit.y, unit.moving], [to[0], to[1], 0], `${from.join(",")} → ${to.join(",")}`);
		assert.ok(ticks <= Math.ceil(distance / speed) + 1 && ticks >= 1, `${from.join(",")} → ${to.join(",")}: ${ticks} ticks for distance ${distance}`);
	}
});

test("stationary units don't move, and the tick still advances", () => {
	const world = makeWorld();
	const unit = spawnUnit(world, 0, tiles(3), tiles(3));

	stepWorld(world);
	stepWorld(world);
	assert.deepEqual([unit.x, unit.y, world.tick], [tiles(3), tiles(3), 2]);
});

test("a stopped unit halts where it is", () => {
	const world = makeWorld();
	const unit = spawnUnit(world, 0, tiles(1), tiles(1));

	applyCommand(world, 0, { "type": "move", "units": [unit.id], "x": tiles(20), "y": tiles(1) });
	stepWorld(world);
	stepWorld(world);
	applyCommand(world, 0, { "type": "stop", "units": [unit.id] });

	const stoppedAt = unit.x;

	stepWorld(world);
	assert.equal(unit.x, stoppedAt);
	assert.equal(unit.x, tiles(1) + 250);
});
