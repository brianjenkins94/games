// Fixed-point scale: 1 FP unit = 1/1000 world unit.
// Positions stored as Int32 in FP; 1000 FP = 1 pixel at 1:1 scale.
export const FP       = 1000;
export const WORLD_W  = 640 * FP;
export const WORLD_H  = 480 * FP;
export const TICK_MS  = 50;           // 20 TPS
export const UNIT_SPD = 3 * FP;       // 3 px / tick  (~10.7 ticks per 32-px tile)
export const MAX_LEAD = 6;            // host can run this many ticks ahead of peer
export const TILE_PX  = 32;          // pixels per tile
export const WALK_PX  = 8;           // collision cell size; rest positions snap to THIS grid (not 32px)

/** Convert a tile coordinate to the FP world position of its centre. */
export function tileCenterFP(t: number): number { return t * TILE_PX * FP + (TILE_PX >> 1) * FP; }

/** Convert an FP world position to the tile it falls in. */
export function fpToTile(fp: number): number { return (fp / FP / TILE_PX) | 0; }

/** Snap an FP world position to the nearest 8px collision-cell boundary.  A 32px box whose centre
 *  sits on this grid occupies exactly 4 whole cells (no straddling), so units rest cleanly here —
 *  4× finer than the 32px tile grid, which lets a formation anchor at sub-tile positions. */
export function snapWalkFP(fp: number): number { const w = WALK_PX * FP; return Math.round(fp / w) * w; }

const CAP = 4096;

export const Position   = { x: new Int32Array(CAP), y: new Int32Array(CAP) };
// SC-style movement: tx/ty is the FINAL goal point in FP (not a per-tile waypoint).
// The movement system steers toward it via the flow field; `active` = 1 while moving.
export const MoveTarget = { tx: new Int32Array(CAP), ty: new Int32Array(CAP), active: new Uint8Array(CAP) };
// `type` is an interned unit-type id (see game/unitTypes.ts), 0 = none/unknown.
// It is authoritative identity but never changes, so it rides in snapshots
// (survives resync) yet is deliberately excluded from the position hash.
// `movable` (local-only, not snapshotted): 1 = this peer simulates the unit and may
// displace it via collision; 0 = display-only obstacle (an enemy known purely from
// snapshots on the guest) — it still COLLIDES (own units route around it) but is
// never itself moved by the local movement system.  The referee sims both teams, so
// all of its units are movable; only the guest holds movable=0 enemies.
export const Unit       = { team: new Uint8Array(CAP), selected: new Uint8Array(CAP), type: new Uint16Array(CAP), movable: new Uint8Array(CAP) };
// Stable identity that travels in every SPAWN command so both sims can refer
// to the same logical unit regardless of which bitecs eid it was assigned.
export const UnitId     = { id: new Uint32Array(CAP) };

// ── Flow-field path following ─────────────────────────────────────────────────
// The movement system samples the flow field for goalTx/goalTy to get a heading,
// moves continuously toward it (MoveTarget.tx/ty = final goal point), then resolves
// unit–unit and static collisions.
// curTx/curTy = the tile the unit currently sits in (recomputed from Position each
//   tick) — drives flow-field and vision sampling.  For buildings it is the
//   footprint top-left, used to re-lay occupancy on snapshot restore.
// goalTx/goalTy = destination tile (indexes the LRU flow-field cache).
// stuckTicks = consecutive ticks of ~no progress toward the goal; arrival logic
//   settles a unit once this passes a threshold (replaces the old occupancy hacks).

export const Path = {
    active:     new Uint8Array(CAP),   // 1 = following a flow field
    goalTx:     new Int16Array(CAP),   // destination tile x
    goalTy:     new Int16Array(CAP),   // destination tile y
    curTx:      new Int16Array(CAP),   // tile the unit currently sits in
    curTy:      new Int16Array(CAP),
    stuckTicks: new Uint8Array(CAP),   // consecutive low-progress ticks (arrival/settle)
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
