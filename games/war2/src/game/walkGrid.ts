/**
 * Walk grid — the 8px spatial layer for unit collision.  Units keep smooth fixed-point positions.
 *
 * Two distinct jobs:
 *   • TERRAIN (static): a cell is blocked if its 32px tile is impassable or holds a building
 *     (`staticBlocked`, 4 cells per tile).  Movers may never cross it.
 *   • UNITS (dynamic): unit↔unit collision is a DIAMOND (L1 ball, radius `unitRadiusPx`), tested as
 *     exact L1 distance vs summed radii — NOT cell occupancy.  The `_grid` (`cell = eid+1`) is just a
 *     BROAD-PHASE index: each unit stamps the cells around it so a query can gather nearby candidate
 *     eids cheaply, then the precise per-pair L1 test runs.  (A diamond is slim on the diagonals, so
 *     two units on diagonally-adjacent tiles leave a gap a third can thread.)
 *
 * Checks: `footprintFreeAt` (terrain + all units), `footprintSoftFreeAt` (terrain + SETTLED units;
 * passes movers), `footprintStaticFreeAt` (terrain only); `separateFrom` de-penetrates a unit jammed
 * inside a settled one.  Mobile units AND display-only enemy units reserve; buildings don't (static layer).
 *
 * Determinism: pure integer; the broad-phase scan + L1 tests are order-independent, and reservation
 * order (referee's stable eid order, reproduced by snapshot/replay) only affects who-claims-a-cell ties.
 */
import { FP, TILE_PX, UNIT_SPD, Position, Unit, MoveTarget } from "./components";
import { getPassability } from "./passability";
import { buildingAt } from "./occupancy";
import { unitRadiusPx } from "./unitTypes";
import { distance } from "./distance";

export const WALK_PX        = 8;
const WALK_FP               = WALK_PX * FP;
const CELLS_PER_TILE        = TILE_PX / WALK_PX;   // 4
const ENTITY_CAP            = 4096;                // matches the bitecs pool (components.ts CAP)

let _grid: Int32Array | null = null;
let _wW = 0, _wH = 0, _mapW = 0;
let _seen:    Int32Array | null = null;   // per-eid generation stamp, dedupes broad-phase candidates
let _seenGen = 0;

/** A mobile unit's collision radius in FP. */
function unitRadiusFP(eid: number): number { return unitRadiusPx(Unit.type[eid]) * FP; }

export function initWalkGrid(mapW: number, mapH: number): void {
    _mapW = mapW;
    _wW   = mapW * CELLS_PER_TILE;
    _wH   = mapH * CELLS_PER_TILE;
    _grid = new Int32Array(_wW * _wH);
    _seen = new Int32Array(ENTITY_CAP);
    _seenGen = 0;
}

export function resetWalkGrid(): void { _grid?.fill(0); }

/** A walk cell is statically blocked if its 32px tile is impassable terrain or holds
 *  a building footprint. */
function staticBlocked(wx: number, wy: number): boolean {
    const tx = (wx / CELLS_PER_TILE) | 0;
    const ty = (wy / CELLS_PER_TILE) | 0;
    const pass = getPassability();
    if (pass && pass[ty * _mapW + tx] === 1) return true;
    return buildingAt(tx, ty);
}

// Largest unit collision radius (ships = 32px L1) — the broad-phase window pads the query by this so
// no overlapping unit is missed when scanning the grid for candidates.
const MAX_UNIT_RADIUS_FP = 32 * FP;

/** True if the bounding box of a circle (centre xFP,yFP; radius rFP) is in-bounds and clear of static
 *  terrain/buildings.  Sub-tile units use a circle for unit↔unit collision, but terrain is still the
 *  cell grid, so we sweep the circle's cell box against it (a hair conservative at the box corners). */
function terrainClearAt(xFP: number, yFP: number, rFP: number): boolean {
    const wx0 = Math.floor((xFP - rFP) / WALK_FP);
    const wx1 = Math.floor((xFP + rFP - 1) / WALK_FP);
    const wy0 = Math.floor((yFP - rFP) / WALK_FP);
    const wy1 = Math.floor((yFP + rFP - 1) / WALK_FP);
    if (wx0 < 0 || wy0 < 0 || wx1 >= _wW || wy1 >= _wH) return false;   // would leave the map
    for (let wy = wy0; wy <= wy1; wy++)
        for (let wx = wx0; wx <= wx1; wx++)
            if (staticBlocked(wx, wy)) return false;
    return true;
}

/** True if a DIAMOND (L1 ball; centre xFP,yFP; L1 radius rFP) would overlap another unit's diamond.
 *  `settledOnly` ignores units that are themselves moving (MoveTarget.active===1) so a unit flows
 *  through moving traffic but never overlaps a parked one.  Broad-phase: the cell grid gives candidate
 *  eids in a padded window; the precise test is L1 distance (|dx|+|dy|) vs summed radii — sqrt-free,
 *  integer, deterministic.  A diamond is slim on the diagonals, so two diagonally-adjacent units leave
 *  a gap a third threads (the whole point); it is NOT the dodecagon range metric. */
function unitOverlapAt(xFP: number, yFP: number, rFP: number, selfEid: number, settledOnly: boolean): boolean {
    const pad = rFP + MAX_UNIT_RADIUS_FP;
    const wx0 = Math.max(0, Math.floor((xFP - pad) / WALK_FP));
    const wx1 = Math.min(_wW - 1, Math.floor((xFP + pad) / WALK_FP));
    const wy0 = Math.max(0, Math.floor((yFP - pad) / WALK_FP));
    const wy1 = Math.min(_wH - 1, Math.floor((yFP + pad) / WALK_FP));
    const self = selfEid + 1;
    // Scan candidate cells; for each distinct other unit, do the exact L1 test once.  The
    // generation guard (_seen) dedupes a unit that occupies several cells in the window.
    const gen = ++_seenGen;
    for (let wy = wy0; wy <= wy1; wy++) {
        for (let wx = wx0; wx <= wx1; wx++) {
            const v = _grid![wy * _wW + wx];
            if (v === 0 || v === self) continue;
            const other = v - 1;
            if (_seen![other] === gen) continue;
            _seen![other] = gen;
            if (settledOnly && MoveTarget.active[other] === 1) continue;   // pass through moving traffic
            const dx = xFP - Position.x[other], dy = yFP - Position.y[other];
            const sum = rFP + unitRadiusFP(other);
            if (Math.abs(dx) + Math.abs(dy) < sum) return true;            // L1 (diamond) overlap
        }
    }
    return false;
}

/** True if a unit of L1 radius rFP could stand at (xFP,yFP): in-bounds, clear of terrain, and not
 *  overlapping any other unit's diamond. */
export function footprintFreeAt(xFP: number, yFP: number, rFP: number, selfEid: number): boolean {
    return terrainClearAt(xFP, yFP, rFP) && !unitOverlapAt(xFP, yFP, rFP, selfEid, false);
}

/** Clear of terrain only — ignores all units.  (Kept for callers that just need a static check.) */
export function footprintStaticFreeAt(xFP: number, yFP: number, rFP: number): boolean {
    return terrainClearAt(xFP, yFP, rFP);
}

/** Like footprintFreeAt but only *settled* (non-moving) units block — a unit flows through moving
 *  traffic (a convoy) while never overlapping a parked one.  Used for settle and for following. */
export function footprintSoftFreeAt(xFP: number, yFP: number, rFP: number, selfEid: number): boolean {
    return terrainClearAt(xFP, yFP, rFP) && !unitOverlapAt(xFP, yFP, rFP, selfEid, true);
}

/** If a unit at (x,y,r) is OVERLAPPING any SETTLED unit (penetration — it phased in, or one settled
 *  onto it while it was moving), return a step that pushes it back OUT along the separation normal(s),
 *  so a unit never stays jammed inside a parked one.  Sum of per-overlap pushes (depth × centre→centre
 *  direction), capped to one tick's travel.  Zero if not overlapping.  Deterministic integer. */
const _sep: [number, number] = [0, 0];
export function separateFrom(xFP: number, yFP: number, rFP: number, selfEid: number): [number, number] {
    let px = 0, py = 0;
    const reach = rFP + MAX_UNIT_RADIUS_FP;
    const wx0 = Math.max(0, Math.floor((xFP - reach) / WALK_FP));
    const wx1 = Math.min(_wW - 1, Math.floor((xFP + reach) / WALK_FP));
    const wy0 = Math.max(0, Math.floor((yFP - reach) / WALK_FP));
    const wy1 = Math.min(_wH - 1, Math.floor((yFP + reach) / WALK_FP));
    const self = selfEid + 1;
    const gen = ++_seenGen;
    for (let wy = wy0; wy <= wy1; wy++) {
        for (let wx = wx0; wx <= wx1; wx++) {
            const v = _grid![wy * _wW + wx];
            if (v === 0 || v === self) continue;
            const other = v - 1;
            if (_seen![other] === gen) continue;
            _seen![other] = gen;
            if (MoveTarget.active[other] === 1) continue;                 // de-penetrate from PARKED units only
            const dx = xFP - Position.x[other], dy = yFP - Position.y[other];
            const sum = rFP + unitRadiusFP(other);
            const l1 = Math.abs(dx) + Math.abs(dy);
            if (l1 >= sum) continue;                                      // not overlapping
            const pen = sum - l1;
            const mag = distance(dx, dy);
            if (mag === 0) { py += pen; continue; }                      // exact same spot → push +y (deterministic)
            px += Math.trunc(dx * pen / mag);
            py += Math.trunc(dy * pen / mag);
        }
    }
    const m = distance(px, py);
    if (m > UNIT_SPD) { px = Math.trunc(px * UNIT_SPD / m); py = Math.trunc(py * UNIT_SPD / m); }
    _sep[0] = px; _sep[1] = py;
    return _sep;
}

/** DEBUG: the dynamic reservations in a cell rectangle, as [cellX, cellY, ownerEid].  Lets the
 *  inspector render the *real* walk grid and spot phantom (stale) reservations. */
export function debugReservedRegion(minCx: number, minCy: number, maxCx: number, maxCy: number): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    if (!_grid) return out;
    for (let cy = Math.max(0, minCy); cy <= Math.min(_wH - 1, maxCy); cy++) {
        for (let cx = Math.max(0, minCx); cx <= Math.min(_wW - 1, maxCx); cx++) {
            const v = _grid[cy * _wW + cx];
            if (v !== 0) out.push([cx, cy, v - 1]);
        }
    }
    return out;
}

/** Mark/clear the cells covering a box at the given centre.  Unit↔unit collision is circular now, so
 *  this is just the BROAD-PHASE occupancy index: a unit stamps the cells around it (its radius box)
 *  so a query can find it as a candidate; the precise test is the squared-distance circle check. */
function paint(eid: number, xFP: number, yFP: number, hwFP: number, hhFP: number, value: number, margin = 0): void {
    const wx0 = Math.max(0,        Math.floor((xFP - hwFP) / WALK_FP) - margin);
    const wx1 = Math.min(_wW - 1,  Math.floor((xFP + hwFP - 1) / WALK_FP) + margin);
    const wy0 = Math.max(0,        Math.floor((yFP - hhFP) / WALK_FP) - margin);
    const wy1 = Math.min(_wH - 1,  Math.floor((yFP + hhFP - 1) / WALK_FP) + margin);
    const self = eid + 1;
    for (let wy = wy0; wy <= wy1; wy++) {
        for (let wx = wx0; wx <= wx1; wx++) {
            const i = wy * _wW + wx;
            if (value === 0) { if (_grid![i] === self) _grid![i] = 0; }
            else             _grid![i] = self;
        }
    }
}

/** Reserve / free a unit's broad-phase footprint at its CURRENT position (its radius box). */
export function reserveUnit(eid: number): void {
    const r = unitRadiusFP(eid);
    paint(eid, Position.x[eid], Position.y[eid], r, r, eid + 1, 0);
}
export function freeUnit(eid: number): void {
    const r = unitRadiusFP(eid);
    // 1-cell margin so this clears every cell the unit might own, including stale shadows from an
    // unaligned footprint.  Only ever clears cells === self.
    paint(eid, Position.x[eid], Position.y[eid], r, r, 0, 1);
}
