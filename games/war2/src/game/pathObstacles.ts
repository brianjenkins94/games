/**
 * Path obstacles — a per-team grid of tiles occupied by that team's own *settled* (idle) mobile
 * units, fed into the flow field so movers route AROUND parked friendly units instead of being
 * aimed straight at them (then phasing through as a last resort).
 *
 * Why a separate grid rather than the live walk-grid reservations: the flow field is a per-goal
 * Dijkstra cached across ticks, so baking in every *moving* unit would thrash it.  Only settled
 * units are stable enough to path around, and the flow cache is cleared whenever the idle set
 * changes (see world.refreshPathObstacles).  Own-team only: routing around enemies would leak fog,
 * and enemy avoidance is left to the continuous collision in systems/movement.ts.
 *
 * Determinism: this is a pure function of which units are settled and where.  It is rebuilt from
 * world state at deterministic points (tick boundary / command application) and after snapshot
 * restore, so host and guest agree.  This module is plain storage — the rebuild scan lives in
 * world.ts (which can iterate the ECS), avoiding an import cycle with the flow field.
 */

const WALK_PX = 8;
let _mapW = 0, _mapH = 0, _cW = 0, _cH = 0;
const _grids  = new Map<number, Uint8Array>();   // team → 32px tile occupancy (1 = a settled own unit)
const _cgrids = new Map<number, Uint8Array>();   // team → 8px C-SPACE occupancy: cells whose CENTRE a
//   moving unit can't occupy without overlapping a settled one (L1(centre, settled) < r_move+r_settled).
//   This is what makes the local A* sub-tile-aware — it routes a mover's CENTRE around the real diamond
//   footprints (incl. units anchored off-centre that poke into a neighbouring tile/lane).
let _dirty = true;                              // the idle set may have changed → grids need a rebuild

export function initPathObstacles(mapW: number, mapH: number): void {
    _mapW = mapW; _mapH = mapH;
    _cW = mapW * (32 / WALK_PX); _cH = mapH * (32 / WALK_PX);
    _grids.clear(); _cgrids.clear();
    _dirty = true;
}

export function cspaceW(): number { return _cW; }
export function cspaceH(): number { return _cH; }

/** Flag that the settled-unit set may have changed (a unit settled / started moving / spawned / died). */
export function markIdleDirty(): void { _dirty = true; }
export function isIdleDirty(): boolean { return _dirty; }
export function clearIdleDirty(): void { _dirty = false; }

/** Clear every team's grid — called at the start of a rebuild. */
export function resetIdleGrids(): void {
    for (const g of _grids.values())  g.fill(0);
    for (const g of _cgrids.values()) g.fill(0);
}

/** Mark tile index `idx` as holding one of `team`'s settled units. */
export function addIdleTile(team: number, idx: number): void {
    let g = _grids.get(team);
    if (!g) { g = new Uint8Array(_mapW * _mapH); _grids.set(team, g); }
    g[idx] = 1;
}

/** Stamp the C-SPACE diamond of a settled unit at world centre (xPx,yPx): every 8px cell whose centre
 *  is within L1 `sumPx` (= mover radius + settled radius) is un-enterable for a mover's centre.  Strict
 *  `<` so touching (L1 == sum) stays free — a mover may path right up against a settled unit, just not
 *  overlap it.  Deterministic integer. */
export function addIdleCSpace(team: number, xPx: number, yPx: number, sumPx: number): void {
    let g = _cgrids.get(team);
    if (!g) { g = new Uint8Array(_cW * _cH); _cgrids.set(team, g); }
    const cx0 = Math.max(0,        Math.floor((xPx - sumPx) / WALK_PX));
    const cx1 = Math.min(_cW - 1,  Math.floor((xPx + sumPx) / WALK_PX));
    const cy0 = Math.max(0,        Math.floor((yPx - sumPx) / WALK_PX));
    const cy1 = Math.min(_cH - 1,  Math.floor((yPx + sumPx) / WALK_PX));
    for (let cy = cy0; cy <= cy1; cy++) {
        const dyc = Math.abs((cy * WALK_PX + WALK_PX / 2) - yPx);
        if (dyc >= sumPx) continue;
        for (let cx = cx0; cx <= cx1; cx++) {
            const dxc = Math.abs((cx * WALK_PX + WALK_PX / 2) - xPx);
            if (dxc + dyc < sumPx) g[cy * _cW + cx] = 1;
        }
    }
}

/** True if one of `team`'s settled units sits on tile index `idx`. */
export function idleObstacleAt(team: number, idx: number): boolean {
    return _grids.get(team)?.[idx] === 1;
}

/** True if a mover's centre at 8px cell (cx,cy) would overlap one of `team`'s settled units. */
export function cspaceBlockedCell(team: number, cx: number, cy: number): boolean {
    return _cgrids.get(team)?.[cy * _cW + cx] === 1;
}
