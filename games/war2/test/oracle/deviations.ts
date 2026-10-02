/**
 * Where the new sim plays differently from the old one on purpose — each scenario with why. For these, the new sim is
 * held to its own trace (traces/sim/, recorded from it: `npm run record -- --sim`); the old sim still to its original.
 * Everything else, both sims match the original tick for tick. A listed deviation that stops deviating fails the oracle,
 * so this list only ever says what's true.
 */
export const DEVIATIONS: Record<string, string> = {
	// W1: the walk grid is repainted from positions, in stable-id order, every tick (world.ts repaintWalkGrid). Where
	// units overlap — these scenarios spawn them in tight clusters — a cell's owner no longer depends on which unit
	// moved last, a history no snapshot carries. (The hand-written scenarios place one unit per tile: unchanged.)
	// W6 step 3: only beating the best so far is progress (movement.ts Path.bestDist / bestCost), so a unit jittering
	// in and out of a parked unit, or bouncing off a wall short of an unreachable slot, escalates and settles instead
	// of going on for good. Only the scenarios that had such units play differently.
	// W6 step 4: one rule for what blocks a mover (terrain, buildings, parked units; touching allowed), in the stepper
	// and the planner alike — no slip through parked units, no centre-only corner-cut; a blocked step stops at exact
	// contact and slides along the face. Same arrivals by a slightly different line where units brushed past others.
	"around-building": "one rule for what blocks a mover; slides instead of the slip (W6 step 4)",
	"diagonal-gap-NE": "one rule for what blocks a mover: threads the razor by contact and slide, not the slip (W6 step 4)",
	"diagonal-gap-SW": "one rule for what blocks a mover: threads the razor by contact and slide, not the slip (W6 step 4)",
	"pinch-corridor": "progress means beating the best so far: units 1 and 2 settle instead of jittering (W6 step 3); one rule for what blocks a mover (step 4)",
	"production-rally": "progress means beating the best so far: units 5 and 6 settle instead of jittering (W6 step 3); one rule for what blocks a mover (step 4)",
	"random-plains-1": "walk grid repainted from positions each tick (W1); progress means beating the best so far (W6 step 3); one rule for what blocks a mover (step 4)",
	"random-plains-2": "walk grid repainted from positions each tick (W1); progress means beating the best so far (W6 step 3); one rule for what blocks a mover (step 4)",
	"random-plains-3": "walk grid repainted from positions each tick (W1); progress means beating the best so far (W6 step 3); one rule for what blocks a mover (step 4)"
};
