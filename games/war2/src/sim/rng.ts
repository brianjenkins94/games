// xorshift32 — deterministic, seeded, no Math.random() in sim logic. Its state is the world's (`world.rng`).
import type { SimWorld } from "./world.ts";

/** A valid xorshift state from `seed` (never 0, which xorshift can't leave). */
export function rngState(seed: number): number {
	return (seed >>> 0) || 1;
}

export function nextU32(world: SimWorld): number {
	let s = world.rng;

	s ^= s << 13;
	s ^= s >> 17;
	s ^= s << 5;
	world.rng = s;

	return s >>> 0;
}

/** Integer in [lo, hi) */
export function rngRange(world: SimWorld, lo: number, hi: number): number {
	return lo + (nextU32(world) % (hi - lo));
}
