/** A seeded xorshift32 generator. Its whole state is one integer on the world, so it snapshots and restores exactly. */
export interface Rng {
	"state": number;
}

export function createRng(seed: number): Rng {
	// xorshift never leaves 0, so a zero seed would stick there.
	return { "state": (seed >>> 0) || 0x9E3779B9 };
}

/** The next unsigned 32-bit value. */
export function nextU32(rng: Rng): number {
	let x = rng.state;

	x ^= x << 13;
	x ^= x >>> 17;
	x ^= x << 5;
	rng.state = x >>> 0;

	return rng.state;
}

/** An integer in [low, high). */
export function nextInt(rng: Rng, low: number, high: number): number {
	if (!(high > low)) {
		throw new RangeError(`nextInt: empty range [${low}, ${high})`);
	}

	return low + (nextU32(rng) % (high - low));
}
