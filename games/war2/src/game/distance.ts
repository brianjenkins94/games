/**
 * Distance metric — the single source of truth for every range, vision, and
 * magnitude query in the sim.
 *
 * Implements StarCraft's integer "approximate distance" (the BWAPI
 * `getApproxDistance` form): pure integer, no `Math.sqrt`, so it is bit-identical
 * across machines — exactly what deterministic lockstep needs.  Its iso-distance
 * contour is the characteristic ~12-sided polygon (dodecagon) rather than a true
 * circle, matching StarCraft's range feel.
 *
 * Scale-agnostic: pass dx/dy in whatever integer units the caller works in
 * (tiles for vision, fixed-point world units for movement) and compare against a
 * range expressed in those same units.  Keeping one metric here means sight,
 * weapon range, splash, leashing, etc. all measure distance identically.
 */

/** Approximate |(dx, dy)| as an integer using the dodecagonal metric (no sqrt). */
export function distance(dx: number, dy: number): number {
    let min = Math.abs(dx);
    let max = Math.abs(dy);
    if (max < min) { const t = max; max = min; min = t; }   // max = larger leg
    if (min <= (max >> 2)) return max;                       // shallow: flat sides near the axes
    const minCalc = (3 * min) >> 3;                          // ≈ 3/8 · min
    return (minCalc >> 5) + minCalc + max - (max >> 4) - (max >> 6);
}

/** True if (dx, dy) is within range `r` under the dodecagonal metric. */
export function inRange(dx: number, dy: number, r: number): boolean {
    return distance(dx, dy) <= r;
}
