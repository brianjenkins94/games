/**
 * Occupancy grid — tracks which BUILDING (eid) occupies each tile.
 *
 * Since SC-style movement, mobile units no longer reserve tiles here; they collide
 * continuously via their boxes (see systems/movement.ts).  The grid now records only
 * building footprints, making it the authoritative *static* obstacle map: a tile is
 * statically blocked for movement/pathing iff terrain is impassable OR a building
 * sits on it (see buildingAt / buildingAtIdx).
 *
 * Storage: flat Int32Array, 0 = empty, eid+1 = occupied by that entity.
 */

let _grid: Int32Array | null = null;
let _mapW = 0;
let _mapH = 0;

export function initOccupancy(mapW: number, mapH: number): void {
    _mapW = mapW;
    _mapH = mapH;
    _grid = new Int32Array(mapW * mapH); // all 0 = empty
}

export function resetOccupancy(): void {
    _grid?.fill(0);
}

// ── Tile operations ───────────────────────────────────────────────────────────

export function inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && tx < _mapW && ty >= 0 && ty < _mapH;
}

export function occupyTile(tx: number, ty: number, eid: number): void {
    if (!inBounds(tx, ty)) return;
    _grid![ty * _mapW + tx] = eid + 1;
}

export function freeTile(tx: number, ty: number): void {
    if (!inBounds(tx, ty)) return;
    _grid![ty * _mapW + tx] = 0;
}

/** Returns the eid occupying (tx, ty), or -1 if empty. */
export function occupant(tx: number, ty: number): number {
    if (!inBounds(tx, ty)) return -1;
    const v = _grid![ty * _mapW + tx];
    return v === 0 ? -1 : v - 1;
}

export function isEmpty(tx: number, ty: number): boolean {
    return occupant(tx, ty) === -1;
}

/** True if a building footprint covers tile (tx, ty).  Out-of-bounds counts as
 *  blocked so callers can clamp at map edges without a separate bounds check. */
export function buildingAt(tx: number, ty: number): boolean {
    if (!inBounds(tx, ty)) return true;
    return _grid![ty * _mapW + tx] !== 0;
}

/** Index-form of buildingAt for hot loops that already hold a flat tile index.
 *  (No bounds check — caller guarantees the index is in-range.) */
export function buildingAtIdx(i: number): boolean {
    return _grid![i] !== 0;
}

// ── Rectangle operations (building footprints) ────────────────────────────────

/** Mark a w×h tile rectangle (top-left tx,ty) as occupied by eid. */
export function occupyRect(tx: number, ty: number, w: number, h: number, eid: number): void {
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
            occupyTile(tx + x, ty + y, eid);
}

/** Free a w×h tile rectangle (top-left tx,ty). */
export function freeRect(tx: number, ty: number, w: number, h: number): void {
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
            freeTile(tx + x, ty + y);
}

/** True if every tile in the w×h rectangle is in-bounds and empty. */
export function rectEmpty(tx: number, ty: number, w: number, h: number): boolean {
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            if (!inBounds(tx + x, ty + y)) return false;
            if (!isEmpty(tx + x, ty + y)) return false;
        }
    return true;
}
