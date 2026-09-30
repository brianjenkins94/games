/**
 * Fixed-point units. Positions and distances are integers in 1/FP of a tile, so every sim operation is exact and
 * reproduces bit-for-bit across machines and runs (no floats reach sim state).
 */
export const FP = 1000;

/** Whole tiles → fixed-point. */
export function tiles(count: number): number {
	return count * FP;
}

/**
 * Integer approximation of Euclidean distance (octagonal: `max + 3/8·min`, within ~7% of true length). Cheap,
 * exact, and the one metric the sim uses for both movement and vision.
 */
export function approxDistance(dx: number, dy: number): number {
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	const high = Math.max(ax, ay);
	const low = Math.min(ax, ay);

	return high + Math.trunc((low * 3) / 8);
}
