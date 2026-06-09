// Fixed-point scale: 1 FP unit = 1/1000 world unit.
// Positions stored as Int32 in FP; 1000 FP = 1 pixel at 1:1 scale.
export const FP       = 1000;
export const WORLD_W  = 640 * FP;
export const WORLD_H  = 480 * FP;
export const TICK_MS  = 50;           // 20 TPS
export const UNIT_SPD = 3 * FP;       // 3 px / tick  (~10.7 ticks per 32-px tile)
export const MAX_LEAD = 6;            // host can run this many ticks ahead of peer
export const TILE_PX  = 32;          // pixels per tile

/** Convert a tile coordinate to the FP world position of its centre. */
export function tileCenterFP(t: number): number { return t * TILE_PX * FP + (TILE_PX >> 1) * FP; }

/** Convert an FP world position to the tile it falls in. */
export function fpToTile(fp: number): number { return (fp / FP / TILE_PX) | 0; }

const CAP = 4096;

export const Position   = { x: new Int32Array(CAP), y: new Int32Array(CAP) };
export const MoveTarget = { tx: new Int32Array(CAP), ty: new Int32Array(CAP), active: new Uint8Array(CAP) };
// `type` is an interned unit-type id (see game/unitTypes.ts), 0 = none/unknown.
// It is authoritative identity but never changes, so it rides in snapshots
// (survives resync) yet is deliberately excluded from the position hash.
export const Unit       = { team: new Uint8Array(CAP), selected: new Uint8Array(CAP), type: new Uint16Array(CAP) };
// Stable identity that travels in every SPAWN command so both sims can refer
// to the same logical unit regardless of which bitecs eid it was assigned.
export const UnitId     = { id: new Uint32Array(CAP) };

// ── Flow-field path following ─────────────────────────────────────────────────
// MoveTarget always points at the next tile centre.  The movement system reads
// the flow field for the unit's goal and steers tile-by-tile.
// curTx/curTy = tile currently occupied in the OccupancyGrid.
// goalTx/goalTy = destination tile (indexes the LRU flow-field cache).

export const Path = {
    active: new Uint8Array(CAP),   // 1 = following a flow field
    goalTx: new Int16Array(CAP),   // destination tile x
    goalTy: new Int16Array(CAP),   // destination tile y
    curTx:  new Int16Array(CAP),   // tile currently occupied
    curTy:  new Int16Array(CAP),
};

// ── Buildings ─────────────────────────────────────────────────────────────────
// Buildings share the unit entity pool (Position + Unit + UnitId, plus inert
// MoveTarget/Path/UnitAnim so they pass the movement query and are skipped).
// `fw`/`fh` are the footprint in tiles (0 = not a building); `buildLeft` is
// construction ticks remaining (0 = complete).  Path.curTx/curTy hold the
// footprint's top-left tile so occupancy can be re-laid on snapshot restore.
export const Building = {
    fw:        new Uint8Array(CAP),
    fh:        new Uint8Array(CAP),
    buildLeft: new Uint16Array(CAP),
};

// ── Animation state (renderer-only, never reconciled by the schema) ───────────
// Set exclusively by the movement system so both peers always agree on direction
// and walk state after running the same deterministic sim tick.  Decoupling this
// from MoveTarget prevents "walking backwards" when Position is snapped by
// applyPatchToWorld but MoveTarget is left pointing at a now-stale tile.

export const UnitAnim = {
    dir:    new Uint8Array(CAP).fill(4),  // last step direction 0-7 (default S=4)
    moving: new Uint8Array(CAP),          // 1 = walk cycle, 0 = idle / waiting
};
