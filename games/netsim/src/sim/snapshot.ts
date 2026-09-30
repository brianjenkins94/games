/**
 * Snapshots: the complete sim state as plain data (structured-cloneable, JSON-safe). Restoring one and replaying the
 * same commands reproduces continuous play exactly — the contract incident replay and desync checks rest on. Units
 * are encoded field by field from UNIT_FIELDS, so nothing on a unit can be missed.
 */
import type { Unit, World, WorldConfig } from "./world.ts";
import { UNIT_FIELDS } from "./world.ts";

export interface Snapshot {
	"config": WorldConfig;
	"tick": number;
	"rngState": number;
	"nextUnitId": number;
	/** Each unit as its UNIT_FIELDS values, in id order. */
	"units": number[][];
}

export function encodeUnit(unit: Unit): number[] {
	return UNIT_FIELDS.map((field) => unit[field]);
}

export function decodeUnit(values: readonly number[]): Unit {
	if (values.length !== UNIT_FIELDS.length) {
		throw new RangeError(`decodeUnit: expected ${UNIT_FIELDS.length} fields, got ${values.length}`);
	}

	return Object.fromEntries(UNIT_FIELDS.map((field, index) => [field, values[index]])) as Unit;
}

export function takeSnapshot(world: World): Snapshot {
	return {
		"config": { ...world.config },
		"tick": world.tick,
		"rngState": world.rng.state,
		"nextUnitId": world.nextUnitId,
		"units": [...world.units.values()].map(encodeUnit)
	};
}

/** A new world from a snapshot, sharing nothing with it (restore the same snapshot twice: two independent worlds). */
export function restoreWorld(snapshot: Snapshot): World {
	const units = new Map<number, Unit>();

	for (const values of snapshot.units) {
		const unit = decodeUnit(values);

		units.set(unit.id, unit);
	}

	return { "config": { ...snapshot.config }, "tick": snapshot.tick, "rng": { "state": snapshot.rngState }, "nextUnitId": snapshot.nextUnitId, "units": units };
}
