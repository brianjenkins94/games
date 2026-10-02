/**
 * Shared game-layer types imported by both the sim (world.ts) and the network
 * protocol (net/protocol.ts).  Keeping them here prevents either module from
 * depending on the other.
 */

/** A queued unit action (the action-queue item).  A discriminated union so attack/patrol/gather can
 *  be added later without touching the queue plumbing.  Lives here (no sim/protocol deps) so both the
 *  sim and the wire snapshot can reference it. */
export type Order =
	| { "kind": "move"; "txFP": number; "tyFP": number }
	| { "kind": "stop" };

/** A building's production state: queued product typeIds + the head item's countdown. */
export interface ProductionState { "queue": number[]; "ticksLeft": number; "ticksTotal": number }

/** Full state of a single sim unit: its stable id, and every sim field's value in SIM_FIELDS order (components.ts) —
 *  so nothing a component holds can be left out. Plus its queue state, keyed elsewhere by uid. */
export interface UnitSnapshot {
	"uid": number;
	"values": number[];
	"orders"?: Order[];                              // mobile unit's pending action queue
	"prod"?: ProductionState;                        // building's production queue (head countdown)
	"rally"?: { "txFP": number; "tyFP": number };        // building's rally point
}
