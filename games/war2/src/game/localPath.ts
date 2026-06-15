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

export const LOCAL_RANGE   = 6;             // tiles: within this of the goal, steer with the local A*
const CELLS_PER_TILE       = 4;             // 8px cells per 32px tile
const RANGE_CELLS          = LOCAL_RANGE * CELLS_PER_TILE;   // A* window radius around the goal (cells)
const STEP_AHEAD           = 1;             // aim the NEXT path cell — hug the path so bends are taken as
                                            // clean full moves (no slip/corner-cut); slip stays for the
                                            // straight razor (touching) cells the planner legitimately uses.
const DIR_COST = [10, 14, 10, 14, 10, 14, 10, 14] as const;

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

/** A cell is terrain-blocked if its 32px tile is impassable or holds a building. */
function terrainCell(pass: Uint8Array, cx: number, cy: number): boolean {
    const ti = (cy >> 2) * _mapW + (cx >> 2);
    return pass[ti] === 1 || buildingAtIdx(ti);
}

/**
 * Sub-tile aim point (FP [x,y]) a mover at (uxFP,uyFP) should steer toward to reach (gxFP,gyFP) while
 * routing its CENTRE around this team's settled units' C-space, or null if there's no local route
 * (caller falls back to the flow field).  The start cell is C-space-exempt (the mover may currently
 * touch/overlap a parked unit and must be able to path out).
 */
export function localNextAim(team: number, uxFP: number, uyFP: number, gxFP: number, gyFP: number): [number, number] | null {
    const pass = getBelievedPassability(team);
    if (!pass || !_g) return null;
    const cW = _cW;
    const ucx = Math.floor(uxFP / 8000), ucy = Math.floor(uyFP / 8000);
    const gcx = Math.floor(gxFP / 8000), gcy = Math.floor(gyFP / 8000);
    if (ucx < 0 || ucy < 0 || ucx >= cW || ucy >= _cH) return null;
    const startIdx = ucy * cW + ucx;
    const goalIdx  = gcy * cW + gcx;
    if (startIdx === goalIdx) return null;   // already in the goal cell → movement beelines the exact point

    const blockedTerrain = (cx: number, cy: number): boolean => terrainCell(pass, cx, cy);
    const blocked = (idx: number, cx: number, cy: number): boolean =>
        blockedTerrain(cx, cy) || (idx !== startIdx && idx !== goalIdx && cspaceBlockedCell(team, cx, cy));
    if (blockedTerrain(gcx, gcy)) return null;   // goal on terrain → let the flow field decide

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
            // Only a TERRAIN corner blocks a diagonal — the C-space already encodes unit clearance, so
            // a diagonal may thread a unit gap (where both diagonal cells are C-space-free).
            if (DIR_DX[d] !== 0 && DIR_DY[d] !== 0) {
                if (blockedTerrain(nx, y) || blockedTerrain(x, ny)) continue;
            }
            const ng = gcur + DIR_COST[d];
            if (_stamp![ni] !== gen || ng < _g![ni]) {
                _g![ni] = ng; _from![ni] = idx; _stamp![ni] = gen;
                heap.push(ng + octile(gcx - nx, gcy - ny), ni);
            }
        }
    }
    if (!found) return null;

    // Walk the parent chain back from the goal into _path[0..len) (goal → … → start), then aim a few
    // cells ahead of the start for smooth steering (re-planned every tick).
    let len = 0, cur = goalIdx;
    while (cur !== -1 && len < _path!.length) { _path![len++] = cur; cur = _from![cur]; }
    const wi = len - 1 - STEP_AHEAD;                       // index toward the goal from the start
    const aimIdx = _path![wi > 0 ? wi : 0];                // (len-1 is the start; clamp into the path)
    const acx = aimIdx % cW, acy = (aimIdx / cW) | 0;
    return [(acx * 8 + 4) * 1000, (acy * 8 + 4) * 1000];   // cell-centre world position in FP
}
