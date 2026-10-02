/**
 * Walk grid — the 8px spatial layer for unit collision.  Units keep smooth fixed-point positions.  Every collider is
 * one kind of shape (collide.ts): a box with 45° corners cut, tested by summing two shapes' bounds.
 *
 * Two distinct jobs:
 *   • TERRAIN (static): `terrainClearAt` tests the unit against impassable tiles (collide.WALL — diamonds, corner-
 *     passable) and buildings (collide.buildingShape — undersized octagons).  Movers may never cross it.
 *   • UNITS (dynamic): unit↔unit collision is each unit's shape (collide.unitShape — a diamond today), tested
 *     exactly — NOT by cell occupancy.  The `grid` (`cell = eid+1`) is just a BROAD-PHASE index: each unit stamps the
 *     cells around it so a query can gather nearby candidate eids cheaply, then the precise per-pair test runs.  (A
 *     diamond is slim on the diagonals, so two units on diagonally-adjacent tiles leave a gap a third can thread.)
 *
 * Checks: `footprintSoftFreeAt` (terrain + buildings + SETTLED units; passes movers — the one rule for what blocks a
 * mover, W6); `separateFrom` de-penetrates a unit jammed inside a settled one.  Mobile units AND display-only enemy units reserve; buildings don't (static layer).
 *
 * Determinism: pure integer; the broad-phase scan + L1 tests are order-independent, and reservation
 * order (referee's stable eid order, reproduced by snapshot/replay) only affects who-claims-a-cell ties.
 *
 * The grid and its scratch are the world's (`world.walk`).
 */
import type { Shape } from "./collide.ts";
import type { SimWorld } from "./world.ts";
import { buildingShape, overlaps, unitShape, unitsDepth, unitsOverlap, WALL } from "./collide.ts";
import { FP, MAX_ENTITIES, TILE_PX, UNIT_SPD } from "./components.ts";
import { distance } from "./distance.ts";
import { occupant } from "./occupancy.ts";

export const WALK_PX = 8;
const WALK_FP = WALK_PX * FP;
const CELLS_PER_TILE = TILE_PX / WALK_PX;   // 4
/** A world's walk grid: the broad-phase cells (8px; `cell = eid+1`), its size in cells, and scratch. */
export interface WalkGrid {
	"grid": Int32Array;
	"wW": number;
	"wH": number;
	/** Per-eid generation stamp, dedupes broad-phase candidates. */
	"seen": Int32Array;
	"seenGen": number;
	/** separateFrom's result, reused. */
	"sep": [number, number];
}

export function createWalkGrid(mapW: number, mapH: number): WalkGrid {
	const wW = mapW * CELLS_PER_TILE;
	const wH = mapH * CELLS_PER_TILE;

	return { "grid": new Int32Array(wW * wH), "wW": wW, "wH": wH, "seen": new Int32Array(MAX_ENTITIES + 1), "seenGen": 0, "sep": [0, 0] };
}

/** A mobile unit's collision shape (FP). */
function shapeOf(world: SimWorld, eid: number): Shape { return unitShape(world.components.Unit.type[eid]); }

export function resetWalkGrid(world: SimWorld): void { world.walk?.grid.fill(0); }

// Largest unit collision radius (ships = 32px L1) — the broad-phase window pads the query by this so
// no overlapping unit is missed when scanning the grid for candidates.
const MAX_UNIT_RADIUS_FP = 32 * FP;

const TILE_FP = TILE_PX * FP;
const HALF_TILE_FP = (TILE_PX >> 1) * FP;   // a tile's half-extent (16px)

/** Shared static-terrain test — the single source of truth for BOTH the mover (real passability) and the
 *  planner (localPath, believed passability), so their terrain models can never silently desync.  A unit of shape
 *  `self` centred at (xFP,yFP) on the given `pass` grid, against:
 *    • WALL tiles (collide.WALL, the inscribed diamond) — so a unit threads a diagonal wall pinch just as it
 *      threads two diagonally-placed units, and corners pass.
 *    • BUILDINGS (collide.buildingShape about Position) — footprint inset 8px, corners cut 8px, so units round
 *      building corners.
 *    • map border = a hard box (the unit's whole shape must stay on the map).
 *  Sqrt-free, integer, deterministic. */
export function terrainClearForPass(world: SimWorld, pass: Uint8Array | null, xFP: number, yFP: number, self: Shape): boolean {
	if (!pass) { return true; }
	const { w: mapW, h: mapH } = world.terrain;
	const { Building, Position } = world.components;
	if (xFP - self.w < 0 || yFP - self.h < 0 || xFP + self.w > mapW * TILE_FP || yFP + self.h > mapH * TILE_FP) { return false; }
	const reachX = self.w + HALF_TILE_FP; const
		reachY = self.h + HALF_TILE_FP;   // the shape's extent + a tile's half-extent
	const tx0 = Math.max(0, ((xFP - reachX) / TILE_FP) | 0); const
		tx1 = Math.min(mapW - 1, ((xFP + reachX) / TILE_FP) | 0);
	const ty0 = Math.max(0, ((yFP - reachY) / TILE_FP) | 0); const
		ty1 = Math.min(mapH - 1, ((yFP + reachY) / TILE_FP) | 0);

	for (let ty = ty0; ty <= ty1; ty++) {
		for (let tx = tx0; tx <= tx1; tx++) {
			if (pass[ty * mapW + tx] === 1) {
				if (overlaps(WALL, self, xFP - (tx * TILE_FP + HALF_TILE_FP), yFP - (ty * TILE_FP + HALF_TILE_FP))) { return false; }
				continue;
			}

			const beid = occupant(world, tx, ty);

			if (beid < 0) { continue; }
			if (overlaps(buildingShape(Building.fw[beid], Building.fh[beid]), self, xFP - Position.x[beid], yFP - Position.y[beid])) { return false; }
		}
	}

	return true;
}

/** Mover-side terrain test: shared logic against the REAL passability grid. */
function terrainClearAt(world: SimWorld, xFP: number, yFP: number, self: Shape): boolean {
	return terrainClearForPass(world, world.terrain.pass, xFP, yFP, self);
}

/** True if a unit of shape `self` centred at (xFP,yFP) would overlap another unit's shape.  `settledOnly` ignores
 *  units that are themselves moving (MoveTarget.active===1) so a unit flows through moving traffic but never
 *  overlaps a parked one.  Broad-phase: the cell grid gives candidate eids in a padded window; the precise test is
 *  the summed shapes (collide.overlaps) — sqrt-free, integer, deterministic.  A diamond is slim on the diagonals, so
 *  two diagonally-adjacent units leave a gap a third threads (the whole point); it is NOT the dodecagon range metric. */
function unitOverlapAt(world: SimWorld, xFP: number, yFP: number, self: Shape, selfEid: number, settledOnly: boolean, yieldTo?: (other: number) => boolean): boolean {
	const walk = world.walk;
	const { grid, wW, wH, seen } = walk;
	const { MoveTarget, Position } = world.components;
	const padX = self.w + MAX_UNIT_RADIUS_FP; const
		padY = self.h + MAX_UNIT_RADIUS_FP;
	const wx0 = Math.max(0, Math.floor((xFP - padX) / WALK_FP));
	const wx1 = Math.min(wW - 1, Math.floor((xFP + padX) / WALK_FP));
	const wy0 = Math.max(0, Math.floor((yFP - padY) / WALK_FP));
	const wy1 = Math.min(wH - 1, Math.floor((yFP + padY) / WALK_FP));
	const selfCell = selfEid + 1;
    // Scan candidate cells; for each distinct other unit, do the exact L1 test once.  The
    // generation guard (seen) dedupes a unit that occupies several cells in the window.
	walk.seenGen += 1;
	const gen = walk.seenGen;

	for (let wy = wy0; wy <= wy1; wy++) {
		for (let wx = wx0; wx <= wx1; wx++) {
			const v = grid[wy * wW + wx];

			if (v === 0 || v === selfCell) { continue; }
			const other = v - 1;

			if (seen[other] === gen) { continue; }
			seen[other] = gen;
			if (settledOnly && MoveTarget.active[other] === 1 && yieldTo?.(other) !== true) { continue; }   // pass through moving traffic (bar those it yields to)
			if (unitsOverlap(self, shapeOf(world, other), xFP - Position.x[other], yFP - Position.y[other])) { return true; }
		}
	}

	return false;
}

/** True if a unit of shape `self` could stand at (xFP,yFP) under the one rule for what blocks a mover (W6): in-bounds,
 *  clear of terrain and buildings, and not overlapping a *settled* (non-moving) unit — it flows through moving traffic
 *  (a convoy) while never overlapping a parked one — bar the movers `yieldTo` names, which block like parked units (a
 *  queue: W6 step 6).  The stepper's test, settle's, and an order's goal check. */
export function footprintSoftFreeAt(world: SimWorld, xFP: number, yFP: number, self: Shape, selfEid: number, yieldTo?: (other: number) => boolean): boolean {
	return terrainClearAt(world, xFP, yFP, self) && !unitOverlapAt(world, xFP, yFP, self, selfEid, true, yieldTo);
}

/** If a unit of shape `self` at (x,y) is OVERLAPPING any SETTLED unit (penetration — it phased in, or one settled
 *  onto it while it was moving), return a step that pushes it back OUT along the separation normal(s),
 *  so a unit never stays jammed inside a parked one.  Sum of per-overlap pushes (depth × centre→centre
 *  direction), capped to one tick's travel.  Zero if not overlapping.  Deterministic integer. */
export function separateFrom(world: SimWorld, xFP: number, yFP: number, self: Shape, selfEid: number): [number, number] {
	const walk = world.walk;
	const { grid, wW, wH, seen } = walk;
	const { MoveTarget, Position } = world.components;
	let px = 0; let
		py = 0;
	const reachX = self.w + MAX_UNIT_RADIUS_FP; const
		reachY = self.h + MAX_UNIT_RADIUS_FP;
	const wx0 = Math.max(0, Math.floor((xFP - reachX) / WALK_FP));
	const wx1 = Math.min(wW - 1, Math.floor((xFP + reachX) / WALK_FP));
	const wy0 = Math.max(0, Math.floor((yFP - reachY) / WALK_FP));
	const wy1 = Math.min(wH - 1, Math.floor((yFP + reachY) / WALK_FP));
	const selfCell = selfEid + 1;
	walk.seenGen += 1;
	const gen = walk.seenGen;

	for (let wy = wy0; wy <= wy1; wy++) {
		for (let wx = wx0; wx <= wx1; wx++) {
			const v = grid[wy * wW + wx];

			if (v === 0 || v === selfCell) { continue; }
			const other = v - 1;

			if (seen[other] === gen) { continue; }
			seen[other] = gen;
			if (MoveTarget.active[other] === 1) { continue; }                 // de-penetrate from PARKED units only
			const dx = xFP - Position.x[other]; const
				dy = yFP - Position.y[other];
			const pen = unitsDepth(self, shapeOf(world, other), dx, dy);

			if (pen <= 0) { continue; }                                       // not overlapping
			const mag = distance(dx, dy);

			if (mag === 0) { py += pen; continue; }                      // exact same spot → push +y (deterministic)
			px += Math.trunc(dx * pen / mag);
			py += Math.trunc(dy * pen / mag);
		}
	}

	const m = distance(px, py);

	if (m > UNIT_SPD) { px = Math.trunc(px * UNIT_SPD / m); py = Math.trunc(py * UNIT_SPD / m); }
	walk.sep[0] = px; walk.sep[1] = py;

	return walk.sep;
}

/** DEBUG: the dynamic reservations in a cell rectangle, as [cellX, cellY, ownerEid].  Lets the
 *  inspector render the *real* walk grid and spot phantom (stale) reservations. */
export function debugReservedRegion(world: SimWorld, minCx: number, minCy: number, maxCx: number, maxCy: number): [number, number, number][] {
	const out: [number, number, number][] = [];

	if (!world.walk) { return out; }
	const { grid, wW, wH } = world.walk;
	for (let cy = Math.max(0, minCy); cy <= Math.min(wH - 1, maxCy); cy++) {
		for (let cx = Math.max(0, minCx); cx <= Math.min(wW - 1, maxCx); cx++) {
			const v = grid[cy * wW + cx];

			if (v !== 0) { out.push([cx, cy, v - 1]); }
		}
	}

	return out;
}

/** Mark/clear the cells covering a box at the given centre.  Unit↔unit collision is circular now, so
 *  this is just the BROAD-PHASE occupancy index: a unit stamps the cells around it (its radius box)
 *  so a query can find it as a candidate; the precise test is the squared-distance circle check. */
function paint(world: SimWorld, eid: number, xFP: number, yFP: number, hwFP: number, hhFP: number, value: number, margin = 0): void {
	const { grid, wW, wH } = world.walk;
	const wx0 = Math.max(0, Math.floor((xFP - hwFP) / WALK_FP) - margin);
	const wx1 = Math.min(wW - 1, Math.floor((xFP + hwFP - 1) / WALK_FP) + margin);
	const wy0 = Math.max(0, Math.floor((yFP - hhFP) / WALK_FP) - margin);
	const wy1 = Math.min(wH - 1, Math.floor((yFP + hhFP - 1) / WALK_FP) + margin);
	const self = eid + 1;

	for (let wy = wy0; wy <= wy1; wy++) {
		for (let wx = wx0; wx <= wx1; wx++) {
			const i = wy * wW + wx;

			if (value === 0) { if (grid[i] === self) { grid[i] = 0; } } else { grid[i] = self; }
		}
	}
}

/** Reserve / free a unit's broad-phase footprint at its CURRENT position (its shape's bounding box). */
export function reserveUnit(world: SimWorld, eid: number): void {
	const { Position } = world.components;
	const shape = shapeOf(world, eid);

	paint(world, eid, Position.x[eid], Position.y[eid], shape.w, shape.h, eid + 1, 0);
}

export function freeUnit(world: SimWorld, eid: number): void {
	const { Position } = world.components;
	const shape = shapeOf(world, eid);

    // 1-cell margin so this clears every cell the unit might own, including stale shadows from an
    // unaligned footprint.  Only ever clears cells === self.
	paint(world, eid, Position.x[eid], Position.y[eid], shape.w, shape.h, 0, 1);
}
