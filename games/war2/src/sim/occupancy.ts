/**
 * Occupancy grid — tracks which BUILDING (eid) occupies each tile.
 *
 * Since SC-style movement, mobile units no longer reserve tiles here; they collide
 * continuously via their boxes (see movement.ts).  The grid now records only
 * building footprints, making it the authoritative *static* obstacle map: a tile is
 * statically blocked for movement/pathing iff terrain is impassable OR a building
 * sits on it (see buildingAtIdx).
 *
 * Storage: the world's `occupancy`, a flat Int32Array over its map (null without one), 0 = empty, eid+1 = occupied by
 * that entity.
 */
import type { SimWorld } from "./world.ts";

export function resetOccupancy(world: SimWorld): void {
	world.occupancy?.fill(0);
}

// ── Tile operations ───────────────────────────────────────────────────────────

export function inBounds(world: SimWorld, tx: number, ty: number): boolean {
	return tx >= 0 && tx < world.terrain.w && ty >= 0 && ty < world.terrain.h;
}

export function occupyTile(world: SimWorld, tx: number, ty: number, eid: number): void {
	if (!inBounds(world, tx, ty)) { return; }
	world.occupancy[ty * world.terrain.w + tx] = eid + 1;
}

export function freeTile(world: SimWorld, tx: number, ty: number): void {
	if (!inBounds(world, tx, ty)) { return; }
	world.occupancy[ty * world.terrain.w + tx] = 0;
}

/** Returns the eid occupying (tx, ty), or -1 if empty. */
export function occupant(world: SimWorld, tx: number, ty: number): number {
	if (!inBounds(world, tx, ty)) { return -1; }
	const v = world.occupancy[ty * world.terrain.w + tx];

	return v === 0 ? -1 : v - 1;
}

export function isEmpty(world: SimWorld, tx: number, ty: number): boolean {
	return occupant(world, tx, ty) === -1;
}

/** True if a building footprint covers the tile at flat index `i`.
 *  (No bounds check — caller guarantees the index is in-range.) */
export function buildingAtIdx(world: SimWorld, i: number): boolean {
	return world.occupancy[i] !== 0;
}

// ── Rectangle operations (building footprints) ────────────────────────────────

/** Mark a w×h tile rectangle (top-left tx,ty) as occupied by eid. */
export function occupyRect(world: SimWorld, tx: number, ty: number, w: number, h: number, eid: number): void {
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) { occupyTile(world, tx + x, ty + y, eid); }
	}
}

/** Free a w×h tile rectangle (top-left tx,ty). */
export function freeRect(world: SimWorld, tx: number, ty: number, w: number, h: number): void {
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) { freeTile(world, tx + x, ty + y); }
	}
}

/** True if every tile in the w×h rectangle is in-bounds and empty. */
export function rectEmpty(world: SimWorld, tx: number, ty: number, w: number, h: number): boolean {
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!inBounds(world, tx + x, ty + y)) { return false; }
			if (!isEmpty(world, tx + x, ty + y)) { return false; }
		}
	}

	return true;
}
