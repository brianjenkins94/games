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
	// (diagonal-gap-NE and -SW deviated here too, threading the razor by contact and slide; step 5's slack, which gives
	// the razor width, put them back on their original line, tick for tick.)
	// W6 step 5: local planning wherever a parked unit (own, or an enemy in sight) blocks the flow, or the unit's stuck;
	// progress rebased when fog re-prices the route; units 2 px slack against each other (a razor 4 px wide, not 0); a
	// unit inside a building placed on it ejected. Same arrivals; slightly different lines where units pass close.
	"group-open": "units 2 px slack against each other (W6 step 5)",
	"build-farm": "units 2 px slack against each other (W6 step 5)",
	"around-building": "one rule for what blocks a mover; slides instead of the slip (W6 step 4); local planning round parked units (step 5)",
	"pinch-corridor": "progress means beating the best so far: units 1 and 2 settle instead of jittering (W6 step 3); one rule for what blocks a mover (step 4); local planning round parked units (step 5)",
	"production-rally": "progress means beating the best so far: units 5 and 6 settle instead of jittering (W6 step 3); one rule for what blocks a mover (step 4); local planning round parked units (step 5)",
	"random-plains-1": "walk grid repainted from positions each tick (W1); progress means beating the best so far (W6 step 3); one rule for what blocks a mover (step 4); local planning round parked units (step 5)",
	"random-plains-2": "walk grid repainted from positions each tick (W1); progress means beating the best so far (W6 step 3); one rule for what blocks a mover (step 4); local planning round parked units (step 5)",
	"random-plains-3": "walk grid repainted from positions each tick (W1); progress means beating the best so far (W6 step 3); one rule for what blocks a mover (step 4); local planning round parked units (step 5)"
};
