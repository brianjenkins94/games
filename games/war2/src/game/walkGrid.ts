/**
 * Walk grid — an 8px reservation grid for unit collision (StarCraft "walk tile" style).
 *
 * Units keep smooth pixel (fixed-point) positions, but each mobile unit *reserves* the
 * fine 8px cells its collision box covers.  A unit may only move to a position whose
 * cells are free — so units can never overlap and never need to shuffle apart; a
 * blocked unit simply slides along or waits.  This replaces the soft AABB separation.
 *
 * Two layers of obstruction:
 *   • static  — impassable terrain or a building footprint, derived on the fly from
 *               the 32px passability + building occupancy (4 walk cells per tile).
 *   • dynamic — `_grid[cell] = eid+1` for the unit currently reserving that cell
 *               (0 = free).  Mobile units AND display-only enemy units reserve;
 *               buildings do not (they're covered by the static layer).
 *
 * Determinism: pure integer; reservation is order-dependent (first unit processed
 * claims a contested cell) but the referee processes units in a stable eid order and
 * snapshot/replay restores that order, so it reproduces exactly.
 */
import { FP, TILE_PX, Position, Unit } from "./components";
import { getPassability } from "./passability";
import { buildingAt } from "./occupancy";
import { unitBoxHalfPx } from "./unitTypes";

export const WALK_PX        = 8;
const WALK_FP               = WALK_PX * FP;
const CELLS_PER_TILE        = TILE_PX / WALK_PX;   // 4

let _grid: Int32Array | null = null;
let _wW = 0, _wH = 0, _mapW = 0;

export function initWalkGrid(mapW: number, mapH: number): void {
    _mapW = mapW;
    _wW   = mapW * CELLS_PER_TILE;
    _wH   = mapH * CELLS_PER_TILE;
    _grid = new Int32Array(_wW * _wH);
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

/** True if a box (centre xFP,yFP; half-extents hwFP,hhFP) could occupy its cells:
 *  fully in-bounds, no static obstruction, and no cell reserved by another unit. */
export function footprintFreeAt(xFP: number, yFP: number, hwFP: number, hhFP: number, selfEid: number): boolean {
    const wx0 = Math.floor((xFP - hwFP) / WALK_FP);
    const wx1 = Math.floor((xFP + hwFP - 1) / WALK_FP);
    const wy0 = Math.floor((yFP - hhFP) / WALK_FP);
    const wy1 = Math.floor((yFP + hhFP - 1) / WALK_FP);
    if (wx0 < 0 || wy0 < 0 || wx1 >= _wW || wy1 >= _wH) return false;   // would leave the map

    const self = selfEid + 1;
    for (let wy = wy0; wy <= wy1; wy++) {
        for (let wx = wx0; wx <= wx1; wx++) {
            if (staticBlocked(wx, wy)) return false;
            const v = _grid![wy * _wW + wx];
            if (v !== 0 && v !== self) return false;
        }
    }
    return true;
}

/** True if a box could occupy its cells ignoring *dynamic* (unit) reservations — i.e. only
 *  in-bounds and no static obstruction.  Used to allow units to slip diagonally past each
 *  other (through a pinch other units form) but never through terrain or buildings. */
export function footprintStaticFreeAt(xFP: number, yFP: number, hwFP: number, hhFP: number): boolean {
    const wx0 = Math.floor((xFP - hwFP) / WALK_FP);
    const wx1 = Math.floor((xFP + hwFP - 1) / WALK_FP);
    const wy0 = Math.floor((yFP - hhFP) / WALK_FP);
    const wy1 = Math.floor((yFP + hhFP - 1) / WALK_FP);
    if (wx0 < 0 || wy0 < 0 || wx1 >= _wW || wy1 >= _wH) return false;

    for (let wy = wy0; wy <= wy1; wy++) {
        for (let wx = wx0; wx <= wx1; wx++) {
            if (staticBlocked(wx, wy)) return false;
        }
    }
    return true;
}

/** If a box is blocked, identify *what* by: returns the eid of the first unit reserving a
 *  cell it overlaps (a soft, possibly-transient obstruction), or -1 if it's blocked by a
 *  hard obstruction (map edge / terrain / building) or not blocked at all.  Lets movement
 *  tell traffic that will clear from a wall it should give up against. */
export function firstUnitBlockerAt(xFP: number, yFP: number, hwFP: number, hhFP: number, selfEid: number): number {
    const wx0 = Math.floor((xFP - hwFP) / WALK_FP);
    const wx1 = Math.floor((xFP + hwFP - 1) / WALK_FP);
    const wy0 = Math.floor((yFP - hhFP) / WALK_FP);
    const wy1 = Math.floor((yFP + hhFP - 1) / WALK_FP);
    if (wx0 < 0 || wy0 < 0 || wx1 >= _wW || wy1 >= _wH) return -1;   // map edge → hard

    const self = selfEid + 1;
    let unit = -1;
    for (let wy = wy0; wy <= wy1; wy++) {
        for (let wx = wx0; wx <= wx1; wx++) {
            if (staticBlocked(wx, wy)) return -1;                   // terrain/building → hard
            const v = _grid![wy * _wW + wx];
            if (v !== 0 && v !== self && unit === -1) unit = v - 1; // remember first unit blocker
        }
    }
    return unit;
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

/** Mark/clear the cells a unit's box covers at the given centre.
 *  `soft` (claim mode only): only take *free* cells, never overwrite another unit's — so a
 *  unit mid-slip doesn't clobber a settled unit's reservation (which freeUnit would then wrongly
 *  clear, leaving a hole another unit could wedge into). */
function paint(eid: number, xFP: number, yFP: number, hwFP: number, hhFP: number, value: number, soft = false, margin = 0): void {
    const wx0 = Math.max(0,        Math.floor((xFP - hwFP) / WALK_FP) - margin);
    const wx1 = Math.min(_wW - 1,  Math.floor((xFP + hwFP - 1) / WALK_FP) + margin);
    const wy0 = Math.max(0,        Math.floor((yFP - hhFP) / WALK_FP) - margin);
    const wy1 = Math.min(_wH - 1,  Math.floor((yFP + hhFP - 1) / WALK_FP) + margin);
    const self = eid + 1;
    for (let wy = wy0; wy <= wy1; wy++) {
        for (let wx = wx0; wx <= wx1; wx++) {
            const i = wy * _wW + wx;
            if (value === 0)   { if (_grid![i] === self) _grid![i] = 0; }
            else if (soft)     { if (_grid![i] === 0)    _grid![i] = self; }
            else               _grid![i] = self;
        }
    }
}

/** Reserve / free a unit's footprint at its CURRENT position (reads Position + box).
 *  `soft` only claims still-free cells — used when a unit is slipping through others. */
export function reserveUnit(eid: number, soft = false): void {
    const [hwPx, hhPx] = unitBoxHalfPx(Unit.type[eid]);
    paint(eid, Position.x[eid], Position.y[eid], hwPx * FP, hhPx * FP, eid + 1, soft);
}
export function freeUnit(eid: number): void {
    const [hwPx, hhPx] = unitBoxHalfPx(Unit.type[eid]);
    // 1-cell margin: also release any cells just outside the current footprint that this unit
    // still owns — stale "shadows" left when a slip's unaligned 5-cell-wide box snaps to a 4-cell
    // aligned rest.  Only ever clears cells === self, so it can't touch another unit's reservation.
    paint(eid, Position.x[eid], Position.y[eid], hwPx * FP, hhPx * FP, 0, false, 1);
}
