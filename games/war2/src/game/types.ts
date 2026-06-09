/**
 * Shared game-layer types imported by both the sim (world.ts) and the network
 * protocol (net/protocol.ts).  Keeping them here prevents either module from
 * depending on the other.
 */

/** Full state snapshot of a single sim unit.
 *  Used by world.ts snapshots and STATE_UPDATE packets. */
export interface UnitSnapshot {
    uid: number; team: number; type: number;
    x: number; y: number;
    mtx: number; mty: number; moveActive: number;
    curTx: number; curTy: number;
    goalTx: number; goalTy: number; pathActive: number;
    dir: number; moving: number;
    bw: number; bh: number; buildLeft: number;   // building footprint + construction ticks (0 = mobile unit)
}
