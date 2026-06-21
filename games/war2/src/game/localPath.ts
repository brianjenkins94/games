/**
 * Local unit-aware pathing — the short-range, SUB-TILE half of the two-tier path system.
 *
 * Long-range navigation around terrain is the cached, terrain-only flow field (flowField.ts).  This
 * layer kicks in within LOCAL_RANGE tiles of the goal, where it matters that a mover routes around
 * nearby parked units — including units anchored OFF-CENTRE on the 8px grid, whose diamonds poke into
 * a neighbouring tile/lane.  A tile-level planner can't see that (the unit "is" in the next tile), so
 * this A* runs on the **8px grid** against the settled units' real C-space footprints
 * (pathObstacles.cspaceBlockedCell): a cell is un-enterable if a mover's CENTRE there would overlap a
 * settled unit.  It returns a sub-tile aim point (FP) a short way along the path to steer toward.
 *
 * Combat-safe: no global cache; a bounded per-unit search run only by units near their goal.  Moving
 * units aren't baked in (they'd thrash the path) — they're handled by the reactive collision in the
 * movement system.  Enemy units aren't included either (own-team only, to keep fog honest).
 *
 * Determinism: a pure function of (team, start, goal, terrain, settled C-space).  Generation-stamped
 * scratch avoids per-call allocation and full clears.
 */

import { getBelievedPassability } from "./vision";
import { buildingAtIdx } from "./occupancy";
import { cspaceBlockedCell } from "./pathObstacles";
import { MinHeap, DIR_DX, DIR_DY } from "./flowField";
import { terrainClearForPass } from "./walkGrid";

export const LOCAL_RANGE   = 6;             // tiles: within this of the goal, steer with the local A*
const CELLS_PER_TILE       = 4;             // 8px cells per 32px tile
const RANGE_CELLS          = LOCAL_RANGE * CELLS_PER_TILE;   // A* window radius around the goal (cells)
const DIR_COST = [10, 14, 10, 14, 10, 14, 10, 14] as const;
const CLEARANCE_MARGIN  = 12000;   // FP: a cell clear at rFP but not rFP+this is "touching" (low clearance)
const CLEARANCE_PENALTY = 40;      // extra A* cost for a low-clearance cell → prefer margin, allow touching

let _mapW = 0, _cW = 0, _cH = 0;
let _g:     Int32Array | null = null;   // gScore (valid only where _stamp === _gen)
let _from:  Int32Array | null = null;   // parent cell along the best path
let _stamp: Int32Array | null = null;   // generation a cell was last touched (0 = never)
let _path:  Int32Array | null = null;   // scratch: path cells walked back from the goal
let _gen = 0;
let _heap:  MinHeap | null = null;

export function initLocalPath(mapW: number, mapH: number): void {
    _mapW = mapW;
    _cW = mapW * CELLS_PER_TILE;
    _cH = mapH * CELLS_PER_TILE;
    const size = _cW * _cH;
    _g = new Int32Array(size);
    _from = new Int32Array(size);
    _stamp = new Int32Array(size);
    _path = new Int32Array(size);
    _gen = 0;
    _heap = new MinHeap(size);
}

/** Octile distance in cell units (cardinal 10, diagonal 14) → admissible A* heuristic. */
function octile(dx: number, dy: number): number {
    dx = dx < 0 ? -dx : dx; dy = dy < 0 ? -dy : dy;
    const lo = dx < dy ? dx : dy, hi = dx < dy ? dy : dx;
    return 10 * hi + 4 * lo;
}

/** True if a mover of L1 radius `rFP` centred at (xFP,yFP) is clear of static terrain on this team's
 *  BELIEVED grid.  Delegates to the SAME test the mover uses (walkGrid.terrainClearForPass) so the
 *  planner's route can never permit a path the mover can't walk — walls as diamonds, buildings as
 *  octagons, identically. */
function terrainClearFP(pass: Uint8Array, xFP: number, yFP: number, rFP: number): boolean {
    return terrainClearForPass(pass, xFP, yFP, rFP, _mapW, (_cH / 4) | 0);
}

/** Cell-centre terrain test for the A* grid (true = blocked for a centre sitting in that cell). */
function terrainCell(pass: Uint8Array, cx: number, cy: number, rFP: number): boolean {
    return !terrainClearFP(pass, (cx * 8 + 4) * 1000, (cy * 8 + 4) * 1000, rFP);
}

/** True if the straight segment (ax,ay)→(bx,by) is traversable for a mover of radius rFP — clear of
 *  terrain AND this team's settled-unit C-space.  Drives the string-pull. */
function losClear(pass: Uint8Array, team: number, ax: number, ay: number, bx: number, by: number, rFP: number): boolean {
    const dx = bx - ax, dy = by - ay;
    const span = Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy);
    const steps = Math.max(1, (span / 4000) | 0);   // sample ~every 4px
    for (let i = 1; i <= steps; i++) {
        const x = ax + ((dx * i / steps) | 0), y = ay + ((dy * i / steps) | 0);
        if (!terrainClearFP(pass, x, y, rFP)) return false;
        if (cspaceBlockedCell(team, (x / 8000) | 0, (y / 8000) | 0)) return false;
    }
    return true;
}

/**
 * Sub-tile aim point (FP [x,y]) a mover at (uxFP,uyFP) should steer toward to reach (gxFP,gyFP) while
 * routing its CENTRE around this team's settled units' C-space, or null if there's no local route
 * (caller falls back to the flow field).  The start cell is C-space-exempt (the mover may currently
 * touch/overlap a parked unit and must be able to path out).
 */
export function localNextAim(team: number, uxFP: number, uyFP: number, gxFP: number, gyFP: number, rFP: number): [number, number] | null {
    const pass = getBelievedPassability(team);
    if (!pass || !_g) return null;
    const cW = _cW;
    const ucx = Math.floor(uxFP / 8000), ucy = Math.floor(uyFP / 8000);
    const gcx = Math.floor(gxFP / 8000), gcy = Math.floor(gyFP / 8000);
    if (ucx < 0 || ucy < 0 || ucx >= cW || ucy >= _cH) return null;
    const startIdx = ucy * cW + ucx;
    const goalIdx  = gcy * cW + gcx;
    if (startIdx === goalIdx) return null;   // already in the goal cell → movement beelines the exact point

    // Terrain is inflated by the mover's footprint (terrainCell); the START cell is exempt so a unit
    // standing legitimately close to a wall can still path out (the continuous collision validates the
    // actual first step anyway).  The GOAL tile only needs to be a passable TILE — a tile-centre goal
    // adjacent to a wall is reachable even though its inflated footprint grazes the wall.
    const blockedTerrain = (cx: number, cy: number): boolean => terrainCell(pass, cx, cy, rFP);
    const blocked = (idx: number, cx: number, cy: number): boolean =>
        idx !== startIdx && idx !== goalIdx && (blockedTerrain(cx, cy) || cspaceBlockedCell(team, cx, cy));
    const goalTi = (gcy >> 2) * _mapW + (gcx >> 2);
    if (pass[goalTi] === 1 || buildingAtIdx(goalTi)) return null;   // goal on terrain → let the flow field decide

    const gen  = ++_gen;
    const heap = _heap!;
    heap.clear();
    _g![startIdx] = 0; _stamp![startIdx] = gen; _from![startIdx] = -1;
    heap.push(octile(gcx - ucx, gcy - ucy), startIdx);

    let found = false;
    while (heap.size > 0) {
        const [f, idx] = heap.pop();
        if (idx === goalIdx) { found = true; break; }
        const x = idx % cW, y = (idx / cW) | 0;
        const gcur = _g![idx];
        if (f - octile(gcx - x, gcy - y) > gcur) continue;   // stale heap entry

        for (let d = 0; d < 8; d++) {
            const nx = x + DIR_DX[d], ny = y + DIR_DY[d];
            if (nx < 0 || nx >= cW || ny < 0 || ny >= _cH) continue;
            // Keep the search bounded to a window around the goal.
            const adx = nx > gcx ? nx - gcx : gcx - nx, ady = ny > gcy ? ny - gcy : gcy - ny;
            if ((adx > ady ? adx : ady) > RANGE_CELLS) continue;

            const ni = ny * cW + nx;
            if (blocked(ni, nx, ny)) continue;
            // Edge (segment) check: two consecutive "touching"-clear cells can still have a wall poking
            // BETWEEN them.  CARDINAL edges use the full footprint (catches a mover sweeping into a wall).
            // DIAGONAL edges use a centre-only test (radius 0) — matching the mover's corner-cut tier,
            // which grazes wall corners — so a diagonal pinch corridor stays threadable.
            if (idx !== startIdx) {
                const mx = (4 * (x + nx) + 4) * 1000, my = (4 * (y + ny) + 4) * 1000;
                if (!terrainClearFP(pass, mx, my, DIR_DX[d] !== 0 && DIR_DY[d] !== 0 ? 0 : rFP)) continue;
            }
            // Clearance cost: penalise cells the mover can only pass by TOUCHING a wall (clear at rFP but
            // not at rFP+margin).  The A* then prefers routes with real clearance — so it doesn't skim an
            // obstacle's edge into a touching-boundary freeze — yet still uses touching cells when they're
            // the only way through (a pinch / 1-tile gap), where the uniform penalty doesn't change the route.
            const wide = terrainClearFP(pass, (nx * 8 + 4) * 1000, (ny * 8 + 4) * 1000, rFP + CLEARANCE_MARGIN);
            const ng = gcur + DIR_COST[d] + (wide ? 0 : CLEARANCE_PENALTY);
            if (_stamp![ni] !== gen || ng < _g![ni]) {
                _g![ni] = ng; _from![ni] = idx; _stamp![ni] = gen;
                heap.push(ng + octile(gcx - nx, gcy - ny), ni);
            }
        }
    }
    if (!found) return null;

    // Walk the parent chain back from the goal into _path[0..len) (goal → … → start).
    let len = 0, cur = goalIdx;
    while (cur !== -1 && len < _path!.length) { _path![len++] = cur; cur = _from![cur]; }

    // String-pull: steer at the FURTHEST path waypoint with clear line-of-sight from the unit — one
    // follower for every case.  It cuts straight across open ground; where terrain/units constrain LOS
    // (gap, pinch, corner) it falls back to the nearest reachable waypoint, funnelling through the
    // corridor centre.  (_path[0] = goal, [len-1] = start.)  Re-planned each tick, so the aim advances.
    for (let i = 0; i < len - 1; i++) {
        const c = _path![i];
        const wx = ((c % cW) * 8 + 4) * 1000, wy = (((c / cW) | 0) * 8 + 4) * 1000;
        if (losClear(pass, team, uxFP, uyFP, wx, wy, rFP)) return [wx, wy];
    }
    const aimIdx = _path![len - 2 >= 0 ? len - 2 : 0];   // nothing visible → next cell along the path
    return [((aimIdx % cW) * 8 + 4) * 1000, (((aimIdx / cW) | 0) * 8 + 4) * 1000];
}
