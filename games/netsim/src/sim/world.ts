/**
 * The sim world — an instance: all of its state lives on the object, so any number of worlds run side by side in
 * one realm without touching each other (war2's module-global component arrays are what this avoids).
 */
import type { Rng } from "./rng.ts";
import { FP } from "./fixed.ts";
import { createRng } from "./rng.ts";

/**
 * Every field of a unit, in canonical order. Snapshot, restore and hashing all enumerate THIS list, so a field
 * can't be added to the sim and silently left out of any of them. All values are integers (`moving` is 0 or 1).
 */
export const UNIT_FIELDS = ["id", "team", "x", "y", "tx", "ty", "moving"] as const;

export type Unit = Record<typeof UNIT_FIELDS[number], number>;

export interface WorldConfig {
	/** Map size in tiles. */
	"width": number;
	"height": number;
	"teams": number;
	"seed": number;
	/** Movement per tick, fixed-point. */
	"speed": number;
	/** Vision radius, fixed-point. */
	"sight": number;
}

export interface World {
	"config": Readonly<WorldConfig>;
	"tick": number;
	"rng": Rng;
	"nextUnitId": number;
	/** By id. Ids only increase, so insertion order is id order: iteration is deterministic. */
	"units": Map<number, Unit>;
}

export function createWorld(config: WorldConfig): World {
	return { "config": { ...config }, "tick": 0, "rng": createRng(config.seed), "nextUnitId": 1, "units": new Map() };
}

/** Fixed-point bounds of the map (exclusive upper). */
export function inBounds(world: World, x: number, y: number): boolean {
	return x >= 0 && y >= 0 && x < world.config.width * FP && y < world.config.height * FP;
}

export function spawnUnit(world: World, team: number, x: number, y: number): Unit {
	if (!Number.isInteger(team) || team < 0 || team >= world.config.teams) {
		throw new RangeError(`spawnUnit: no team ${team}`);
	}

	if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(world, x, y)) {
		throw new RangeError(`spawnUnit: (${x}, ${y}) is off the map`);
	}

	const unit: Unit = { "id": world.nextUnitId, "team": team, "x": x, "y": y, "tx": x, "ty": y, "moving": 0 };

	world.nextUnitId += 1;
	world.units.set(unit.id, unit);

	return unit;
}
