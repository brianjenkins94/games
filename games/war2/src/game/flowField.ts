/**
 * Flow field pathfinding.
 *
 * One reverse-Dijkstra per unique goal tile fills every reachable tile with
 * the direction that leads toward that goal.  All units sharing the same
 * destination read from the same FlowField — one computation regardless of
 * how many units are moving.
 *
 * Direction encoding (0–7):
 *   0=N  1=NE  2=E  3=SE  4=S  5=SW  6=W  7=NW   0xFF=unreachable
 *
 * Diagonal moves use cost 14, cardinal 10 (× integer scale).
 * A diagonal into an open tile is allowed only when 0 or 2 of its flanking tiles are blocked: 0 = a
 * clean diagonal; 2 = a pinch with no cardinal alternative (units thread it — walls are diamonds, see
 * walkGrid).  Exactly 1 flanking wall is excluded, so the field routes CARDINAL around a single corner
 * rather than steering a unit's continuous path into the wall's pocket (movement.ts still cuts the
 * corner when the geometry fits).
 *
 * Obstacles here are ONLY the slow-changing ones: impassable terrain and building footprints.
 * Units are deliberately NOT in the flow field — they change every tick and would thrash the
 * cache.  Long-range navigation around terrain is this layer; routing around *units* is the
 * short-range local search (localPath.ts), and incidental jostling is the continuous collision
 * in the movement system.  (Two-tier pathing: cheap cached terrain field + bounded local search.)
 */

import { getMapW, getMapH } from "./passability";
import { getBelievedPassability, takeBelievedDirty } from "./vision";
import { buildingAtIdx } from "./occupancy";

// ── Direction table ───────────────────────────────────────────────────────────

export const DIR_DX = [ 0,  1,  1,  1,  0, -1, -1, -1] as const;
export const DIR_DY = [-1, -1,  0,  1,  1,  1,  0, -1] as const;
const        DIR_COST = [10, 14, 10, 14, 10, 14, 10, 14] as const;
export const UNREACHABLE = 0xFF;

// ── Flow field ────────────────────────────────────────────────────────────────

export interface FlowField {
    dirs:   Uint8Array; // indexed by tileY * mapW + tileX
    goalTx: number;
    goalTy: number;
}

// ── Min-heap (key=cost, val=tileIndex) ───────────────────────────────────────

export class MinHeap {
    private keys: Int32Array;
    private vals: Int32Array;
    private n = 0;

    constructor(cap: number) {
        this.keys = new Int32Array(cap);
        this.vals = new Int32Array(cap);
    }

    get size() { return this.n; }
    clear(): void { this.n = 0; }

    push(key: number, val: number): void {
        let i = this.n++;
        this.keys[i] = key;
        this.vals[i] = val;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.keys[p] <= this.keys[i]) break;
            this.swap(p, i); i = p;
        }
    }

    pop(): [number, number] {
        const k = this.keys[0], v = this.vals[0];
        const last = --this.n;
        if (last > 0) {
            this.keys[0] = this.keys[last];
            this.vals[0] = this.vals[last];
            let i = 0;
            while (true) {
                const l = 2*i+1, r = 2*i+2;
                let m = i;
                if (l < this.n && this.keys[l] < this.keys[m]) m = l;
                if (r < this.n && this.keys[r] < this.keys[m]) m = r;
                if (m === i) break;
                this.swap(m, i); i = m;
            }
        }
        return [k, v];
    }

    private swap(a: number, b: number): void {
        let t = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = t;
        let u = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = u;
    }
}

// ── Computation ───────────────────────────────────────────────────────────────

const INF = 0x7FFFFFFF;

// Count of actual reverse-Dijkstra runs (cache misses) — a shared per-group goal should make a group
// move cost ONE, not one-per-unit.  Exposed for tests/telemetry; incremented in computeFlowField.
let _computeCount = 0;
export function flowComputeCount(): number { return _computeCount; }

// Reusable scratch for the Dijkstra (the per-field `dirs` is the only thing allocated per call — it's
// returned and cached).  Sized to the map; grown if the map ever gets larger.  Avoids ~19×map-size of
// typed-array garbage — chiefly the size*8 heap — on every flow-field computation.
let _scratchSize = 0;
let _blocked: Uint8Array | null = null;
let _cost: Int32Array | null = null;
let _visited: Uint8Array | null = null;
let _scratchHeap: MinHeap | null = null;
function ensureScratch(size: number): void {
    if (size <= _scratchSize) return;
    _scratchSize = size;
    _blocked = new Uint8Array(size);
    _cost = new Int32Array(size);
    _visited = new Uint8Array(size);
    _scratchHeap = new MinHeap(size * 8);   // each tile can be pushed at most 8 times
}

/**
 * Run reverse-Dijkstra from (goalTx, goalTy) and build a per-tile direction
 * array.  Returns null if the goal tile is terrain-impassable.
 */
export function computeFlowField(team: number, goalTx: number, goalTy: number): FlowField | null {
    // Believed passability for THIS team: unexplored tiles are assumed passable so
    // units path optimistically into fog and re-route on discovery (see vision.ts).
    const pass = getBelievedPassability(team);
    const mapW = getMapW();
    const mapH = getMapH();
    if (!pass || mapW === 0) return null;

    goalTx = Math.max(0, Math.min(mapW - 1, goalTx));
    goalTy = Math.max(0, Math.min(mapH - 1, goalTy));

    _computeCount++;
    const size    = mapW * mapH;
    ensureScratch(size);
    const blocked = _blocked!, cost = _cost!, visited = _visited!, heap = _scratchHeap!;

    // Combined obstacle map (terrain impassable per this team's belief OR a building footprint) plus the
    // cost/visited reset — one pass over the scratch.  Mobile units are NOT here (continuous collision).
    for (let i = 0; i < size; i++) { blocked[i] = (pass[i] || buildingAtIdx(i)) ? 1 : 0; cost[i] = INF; visited[i] = 0; }
    heap.clear();

    const goalIdx = goalTy * mapW + goalTx;
    if (blocked[goalIdx]) return null; // blocked goal

    cost[goalIdx] = 0;
    heap.push(0, goalIdx);

    while (heap.size > 0) {
        const [c, idx] = heap.pop();
        if (visited[idx]) continue;
        visited[idx] = 1;

        const cx = idx % mapW;
        const cy = (idx / mapW) | 0;

        for (let d = 0; d < 8; d++) {
            const nx = cx + DIR_DX[d];
            const ny = cy + DIR_DY[d];
            if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) continue;

            const ni = ny * mapW + nx;
            if (blocked[ni]) continue;
            // Diagonal: allow only when 0 or 2 flanking tiles are blocked.  0 = a clean diagonal;
            // 2 = a pinch with no cardinal alternative (units thread it — wall diamonds).  Exactly 1
            // flanking wall is skipped, so the field routes CARDINAL around a single corner rather than
            // diving the unit's continuous path into the wall's pocket (movement still cuts the corner
            // when the geometry fits).
            if (DIR_DX[d] !== 0 && DIR_DY[d] !== 0 && blocked[cy * mapW + nx] !== blocked[ny * mapW + cx]) continue;

            const nc = c + DIR_COST[d];
            if (nc < cost[ni]) {
                cost[ni] = nc;
                heap.push(nc, ni);
            }
        }
    }

    // Build direction lookup: for each tile, which walkable neighbour has
    // the lowest cost-to-goal?  That direction is the "flow."
    const dirs = new Uint8Array(size).fill(UNREACHABLE);

    for (let ty = 0; ty < mapH; ty++) {
        for (let tx = 0; tx < mapW; tx++) {
            const ti = ty * mapW + tx;
            if (blocked[ti] || ti === goalIdx || cost[ti] === INF) continue;

            let minCost = INF, bestDir = UNREACHABLE;
            for (let d = 0; d < 8; d++) {
                const nx = tx + DIR_DX[d];
                const ny = ty + DIR_DY[d];
                if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) continue;
                const ni = ny * mapW + nx;
                if (blocked[ni]) continue;
                // Diagonal allowed only with 0 or 2 flanking walls (see the Dijkstra pass above).
                if (DIR_DX[d] !== 0 && DIR_DY[d] !== 0 && blocked[ty * mapW + nx] !== blocked[ny * mapW + tx]) continue;

                if (cost[ni] < minCost) { minCost = cost[ni]; bestDir = d; }
            }
            dirs[ti] = bestDir;
        }
    }

    return { dirs, goalTx, goalTy };
}

// ── LRU cache ─────────────────────────────────────────────────────────────────

// Formation moves give each unit in a group its own goal tile (one field each), so
// the cache must hold several groups' worth of distinct goals without thrashing.
const CACHE_CAP = 64;
const _cache    = new Map<number, FlowField>(); // goalIdx → FlowField

export function getOrComputeFlowField(team: number, goalTx: number, goalTy: number): FlowField | null {
    // Newly-explored terrain that proved blocked invalidates fields computed under the prior optimistic
    // belief — drop THIS team's fields so they recompute against reality.  Per-team (not the whole cache),
    // so one team's constant scouting doesn't keep evicting the other team's fields.
    if (takeBelievedDirty(team)) clearFlowFieldCacheForTeam(team);

    const mapW    = getMapW();
    // Cache key includes team so the same goal yields each team's own field.
    const key     = team * (mapW * getMapH()) + goalTy * mapW + goalTx;

    // LRU hit — move to end
    const cached = _cache.get(key);
    if (cached) {
        _cache.delete(key);
        _cache.set(key, cached);
        return cached;
    }

    const ff = computeFlowField(team, goalTx, goalTy);
    if (!ff) return null;

    if (_cache.size >= CACHE_CAP) {
        // Evict least-recently-used (first entry in insertion-order Map)
        _cache.delete(_cache.keys().next().value!);
    }
    _cache.set(key, ff);
    return ff;
}

export function clearFlowFieldCache(): void { _cache.clear(); }

/** Drop only `team`'s cached fields (its goal keys occupy a contiguous span — see the key formula).
 *  Internal: invoked by getOrComputeFlowField when this team's belief turns dirty. */
function clearFlowFieldCacheForTeam(team: number): void {
    const span = getMapW() * getMapH();
    const lo = team * span, hi = lo + span;
    for (const k of _cache.keys()) if (k >= lo && k < hi) _cache.delete(k);
}
