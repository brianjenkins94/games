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
 * Diagonal moves that would clip a blocked corner are excluded from both the
 * Dijkstra and the direction-selection pass, so units never cut corners.
 *
 * Occupancy is NOT included in the flow field — it changes every tick and
 * would require constant recomputation.  Per-unit local steering in the
 * movement system handles unit–unit avoidance.
 */

import { getPassability, getMapW, getMapH } from "./passability";

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

class MinHeap {
    private keys: Int32Array;
    private vals: Int32Array;
    private n = 0;

    constructor(cap: number) {
        this.keys = new Int32Array(cap);
        this.vals = new Int32Array(cap);
    }

    get size() { return this.n; }

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

/**
 * Run reverse-Dijkstra from (goalTx, goalTy) and build a per-tile direction
 * array.  Returns null if the goal tile is terrain-impassable.
 */
export function computeFlowField(goalTx: number, goalTy: number): FlowField | null {
    const pass = getPassability();
    const mapW = getMapW();
    const mapH = getMapH();
    if (!pass || mapW === 0) return null;

    goalTx = Math.max(0, Math.min(mapW - 1, goalTx));
    goalTy = Math.max(0, Math.min(mapH - 1, goalTy));

    const size    = mapW * mapH;
    const goalIdx = goalTy * mapW + goalTx;
    if (pass[goalIdx]) return null; // terrain-blocked goal

    // cost[i] = minimum movement cost to reach goal from tile i
    const cost    = new Int32Array(size).fill(INF);
    const visited = new Uint8Array(size);
    cost[goalIdx] = 0;

    // Heap capacity: each tile can be pushed at most 8 times
    const heap = new MinHeap(size * 8);
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
            if (pass[ni]) continue;

            // Diagonal: block if either orthogonal side is terrain-blocked
            if (DIR_DX[d] !== 0 && DIR_DY[d] !== 0) {
                if (pass[cy * mapW + nx] || pass[ny * mapW + cx]) continue;
            }

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
            if (pass[ti] || ti === goalIdx || cost[ti] === INF) continue;

            let minCost = INF, bestDir = UNREACHABLE;
            for (let d = 0; d < 8; d++) {
                const nx = tx + DIR_DX[d];
                const ny = ty + DIR_DY[d];
                if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) continue;
                const ni = ny * mapW + nx;
                if (pass[ni]) continue;

                if (DIR_DX[d] !== 0 && DIR_DY[d] !== 0) {
                    if (pass[ty * mapW + nx] || pass[ny * mapW + tx]) continue;
                }

                if (cost[ni] < minCost) { minCost = cost[ni]; bestDir = d; }
            }
            dirs[ti] = bestDir;
        }
    }

    return { dirs, goalTx, goalTy };
}

// ── LRU cache ─────────────────────────────────────────────────────────────────

const CACHE_CAP = 16;
const _cache    = new Map<number, FlowField>(); // goalIdx → FlowField

export function getOrComputeFlowField(goalTx: number, goalTy: number): FlowField | null {
    const mapW    = getMapW();
    const goalIdx = goalTy * mapW + goalTx;

    // LRU hit — move to end
    const cached = _cache.get(goalIdx);
    if (cached) {
        _cache.delete(goalIdx);
        _cache.set(goalIdx, cached);
        return cached;
    }

    const ff = computeFlowField(goalTx, goalTy);
    if (!ff) return null;

    if (_cache.size >= CACHE_CAP) {
        // Evict least-recently-used (first entry in insertion-order Map)
        _cache.delete(_cache.keys().next().value!);
    }
    _cache.set(goalIdx, ff);
    return ff;
}

export function clearFlowFieldCache(): void { _cache.clear(); }
