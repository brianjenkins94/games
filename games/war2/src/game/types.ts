/**
 * Shared game-layer types imported by both the sim (world.ts) and the network
 * protocol (net/protocol.ts).  Keeping them here prevents either module from
 * depending on the other.
 */

/** A queued unit action (the action-queue item).  A discriminated union so attack/patrol/gather can
 *  be added later without touching the queue plumbing.  Lives here (no sim/protocol deps) so both the
 *  sim and the wire snapshot can reference it. */
export type Order =
    | { kind: "move"; txFP: number; tyFP: number }
    | { kind: "stop" };

/** A building's production state: queued product typeIds + the head item's countdown. */
export interface ProductionState { queue: number[]; ticksLeft: number; ticksTotal: number }

/** Full state snapshot of a single sim unit.
 *  Used by world.ts snapshots and STATE_UPDATE packets. */
export interface UnitSnapshot {
    uid: number; team: number; type: number;
    x: number; y: number;
    mtx: number; mty: number; moveActive: number;
    curTx: number; curTy: number;
    goalTx: number; goalTy: number; pathActive: number; stuckTicks: number;
    dir: number; moving: number;
    bw: number; bh: number; buildLeft: number;   // building footprint + construction ticks (0 = mobile unit)
    // Optional queue state, carried only on the owner's own-team snapshots (HUD + waypoint/rally render):
    orders?: Order[];                              // mobile unit's pending action queue
    prod?: ProductionState;                        // building's production queue (head countdown)
    rally?: { txFP: number; tyFP: number };        // building's rally point
}
