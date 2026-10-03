// xorshift32 — deterministic, seeded, no Math.random() in sim logic. Its state is the world's (`world.rng`).
import type { SimWorld } from "./world.ts";

/** A valid xorshift state from `seed` (never 0, which xorshift can't leave). */
export function rngState(seed: number): number {
	return (seed >>> 0) || 1;
}

/** One xorshift32 step: the next state (as a signed int; `>>> 0` reads it unsigned). */
function step(state: number): number {
	let s = state;

	s ^= s << 13;
	s ^= s >> 17;
	s ^= s << 5;

	return s;
}

export function nextU32(world: SimWorld): number {
	world.rng = step(world.rng);

	return world.rng >>> 0;
}

/** Integer in [lo, hi) */
export function rngRange(world: SimWorld, lo: number, hi: number): number {
	return lo + (nextU32(world) % (hi - lo));
}

/** The same generator outside a world — for anything else that wants a seeded, repeatable sequence (a bot, a test's
 *  network): each call, the next unsigned 32-bit value. */
export function createRng(seed: number): () => number {
	let state = rngState(seed);

	return () => {
		state = step(state);

		return state >>> 0;
	};
}
