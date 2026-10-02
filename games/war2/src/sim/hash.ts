import type { SimWorld } from "./world.ts";

/** FNV-1a 32-bit, folding in `value`. */
export function fold(hash: number, value: number): number {
	return Math.imul(hash ^ (value | 0), 16777619) >>> 0;
}

/**
 * FNV-1a 32-bit over every sim field (`world.fields`) of the given entities, in stable-id order — not eid order, which
 * a restore reallocates.
 */
export function hashEntities(world: SimWorld, eids: number[], hash = 2166136261): number {
	const { UnitId } = world.components;
	let h = hash;

	for (const eid of eids.slice().sort((a, b) => UnitId.id[a] - UnitId.id[b])) {
		for (const [, column] of world.fields) {
			h = fold(h, column[eid]);
		}
	}

	return h;
}
