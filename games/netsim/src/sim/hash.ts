/**
 * FNV-1a over integers. `hashWorld` covers ALL sim state (every unit field, tick, RNG, id counter) — not just
 * positions — so any divergence shows. `hashUnits` hashes a set of units, e.g. what one team can see, which is what
 * a player's view should match on both ends of the wire.
 */
import type { Unit, World } from "./world.ts";
import { UNIT_FIELDS } from "./world.ts";

const OFFSET = 0x811C9DC5;
const PRIME = 0x01000193;

function mix(hash: number, value: number): number {
	let next = hash;

	// Both 32-bit halves, so large values and negatives hash distinctly.
	for (const word of [value | 0, Math.floor(value / 0x100000000) | 0]) {
		for (let shift = 0; shift < 32; shift += 8) {
			next = Math.imul(next ^ ((word >>> shift) & 0xFF), PRIME);
		}
	}

	return next >>> 0;
}

export function hashUnits(units: Iterable<Unit>): number {
	let hash = OFFSET;

	for (const unit of units) {
		for (const field of UNIT_FIELDS) {
			hash = mix(hash, unit[field]);
		}
	}

	return hash;
}

export function hashWorld(world: World): number {
	let hash = mix(mix(mix(OFFSET, world.tick), world.rng.state), world.nextUnitId);

	hash = mix(hash, hashUnits(world.units.values()));

	return hash;
}
