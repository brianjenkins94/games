/**
 * Where the new sim plays differently from the old one on purpose — each scenario with why. For these, the new sim is
 * held to its own trace (traces/w1/, recorded from it: `npm run record -- --sim`); the old sim still to its original.
 * Everything else, both sims match the original tick for tick. A listed deviation that stops deviating fails the oracle,
 * so this list only ever says what's true.
 */
export const DEVIATIONS: Record<string, string> = {
	// W1: the walk grid is repainted from positions, in stable-id order, every tick (world.ts repaintWalkGrid). Where
	// units overlap — these scenarios spawn them in tight clusters — a cell's owner no longer depends on which unit
	// moved last, a history no snapshot carries. (The hand-written scenarios place one unit per tile: unchanged.)
	"random-plains-1": "walk grid repainted from positions each tick (W1)",
	"random-plains-2": "walk grid repainted from positions each tick (W1)",
	"random-plains-3": "walk grid repainted from positions each tick (W1)"
};
