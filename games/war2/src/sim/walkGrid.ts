/**
 * Walk grid — the 8px spatial layer for unit collision.  Units keep smooth fixed-point positions.
 *
 * Two distinct jobs:
 *   • TERRAIN (static): `terrainClearAt` tests the unit against impassable tiles (DIAMONDS, corner-
 *     passable) and buildings (undersized OCTAGONS).  Movers may never cross it.
 *   • UNITS (dynamic): unit↔unit collision is a DIAMOND (L1 ball, radius `unitRadiusPx`), tested as
 *     exact L1 distance vs summed radii — NOT cell occupancy.  The `grid` (`cell = eid+1`) is just a
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
 *
 * The grid and its scratch are the world's (`world.walk`).
 */
import type { SimWorld } from "./world.ts";
import { FP, MAX_ENTITIES, TILE_PX, UNIT_SPD } from "./components.ts";
import { distance } from "./distance.ts";
import { occupant } from "./occupancy.ts";
import { unitRadiusPx } from "./unitTypes.ts";

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

/** A mobile unit's collision radius in FP. */
function unitRadiusFP(world: SimWorld, eid: number): number { return unitRadiusPx(world.components.Unit.type[eid]) * FP; }

export function resetWalkGrid(world: SimWorld): void { world.walk?.grid.fill(0); }

// Largest unit collision radius (ships = 32px L1) — the broad-phase window pads the query by this so
// no overlapping unit is missed when scanning the grid for candidates.
const MAX_UNIT_RADIUS_FP = 32 * FP;

const TILE_FP = TILE_PX * FP;
const HALF_TILE_FP = (TILE_PX >> 1) * FP;   // a tile's inscribed-diamond / box half-extent (16px)
const BUILD_MARGIN_FP = 8 * FP;             // building collision margin: footprint inset + corner chamfer

/** Shared static-terrain test — the single source of truth for BOTH the mover (real passability) and the
 *  planner (localPath, believed passability), so their terrain models can never silently desync.  A unit
 *  (centre xFP,yFP; L1 radius rFP) on the given `pass` grid:
 *    • WALL tiles = inscribed DIAMONDS (L1 ball, radius = half-tile) — the same shape as a unit, so a unit
 *      threads a diagonal wall pinch just as it threads two diagonally-placed units, and corners pass.
 *    • BUILDINGS = undersized OCTAGONS about Position — footprint inset 8px (matches the structure inside
 *      its sprite padding) with 8px 45° corner chamfers, so units round building corners.
 *    • map border = a hard box (the unit must stay fully on the map).
 *  Sqrt-free, integer, deterministic. */
export function terrainClearForPass(world: SimWorld, pass: Uint8Array | null, xFP: number, yFP: number, rFP: number): boolean {
	if (!pass) { return true; }
	const { w: mapW, h: mapH } = world.terrain;
	const { Building, Position } = world.components;
	if (xFP - rFP < 0 || yFP - rFP < 0 || xFP + rFP > mapW * TILE_FP || yFP + rFP > mapH * TILE_FP) { return false; }
	const reach = rFP + HALF_TILE_FP;   // unit radius + tile half-extent
	const tx0 = Math.max(0, ((xFP - reach) / TILE_FP) | 0); const
		tx1 = Math.min(mapW - 1, ((xFP + reach) / TILE_FP) | 0);
	const ty0 = Math.max(0, ((yFP - reach) / TILE_FP) | 0); const
		ty1 = Math.min(mapH - 1, ((yFP + reach) / TILE_FP) | 0);

	for (let ty = ty0; ty <= ty1; ty++) {
		for (let tx = tx0; tx <= tx1; tx++) {
			if (pass[ty * mapW + tx] === 1) {
				const cx = tx * TILE_FP + HALF_TILE_FP; const
					cy = ty * TILE_FP + HALF_TILE_FP;       // WALL: diamond
				const dx = xFP > cx ? xFP - cx : cx - xFP; const
					dy = yFP > cy ? yFP - cy : cy - yFP;

				if (dx + dy < reach) { return false; }
				continue;
			}

			const beid = occupant(world, tx, ty);

			if (beid < 0) { continue; }
            // BUILDING: undersized octagon about its centre — box half (bxh,byh) inset 8px, corners
            // chamfered 8px (diamond bound dd); overlap = unit inside all three, each grown by rFP.
			const bxh = Math.max(0, Building.fw[beid] * HALF_TILE_FP - BUILD_MARGIN_FP);
			const byh = Math.max(0, Building.fh[beid] * HALF_TILE_FP - BUILD_MARGIN_FP);
			const dd = Math.max(0, bxh + byh - BUILD_MARGIN_FP);
			const dx = xFP > Position.x[beid] ? xFP - Position.x[beid] : Position.x[beid] - xFP;
			const dy = yFP > Position.y[beid] ? yFP - Position.y[beid] : Position.y[beid] - yFP;

			if (dx < bxh + rFP && dy < byh + rFP && dx + dy < dd + rFP) { return false; }
		}
	}

	return true;
}

/** Mover-side terrain test: shared logic against the REAL passability grid. */
function terrainClearAt(world: SimWorld, xFP: number, yFP: number, rFP: number): boolean {
	return terrainClearForPass(world, world.terrain.pass, xFP, yFP, rFP);
}

/** True if a DIAMOND (L1 ball; centre xFP,yFP; L1 radius rFP) would overlap another unit's diamond.
 *  `settledOnly` ignores units that are themselves moving (MoveTarget.active===1) so a unit flows
 *  through moving traffic but never overlaps a parked one.  Broad-phase: the cell grid gives candidate
 *  eids in a padded window; the precise test is L1 distance (|dx|+|dy|) vs summed radii — sqrt-free,
 *  integer, deterministic.  A diamond is slim on the diagonals, so two diagonally-adjacent units leave
 *  a gap a third threads (the whole point); it is NOT the dodecagon range metric. */
function unitOverlapAt(world: SimWorld, xFP: number, yFP: number, rFP: number, selfEid: number, settledOnly: boolean): boolean {
	const walk = world.walk;
	const { grid, wW, wH, seen } = walk;
	const { MoveTarget, Position } = world.components;
	const pad = rFP + MAX_UNIT_RADIUS_FP;
	const wx0 = Math.max(0, Math.floor((xFP - pad) / WALK_FP));
	const wx1 = Math.min(wW - 1, Math.floor((xFP + pad) / WALK_FP));
	const wy0 = Math.max(0, Math.floor((yFP - pad) / WALK_FP));
	const wy1 = Math.min(wH - 1, Math.floor((yFP + pad) / WALK_FP));
	const self = selfEid + 1;
    // Scan candidate cells; for each distinct other unit, do the exact L1 test once.  The
    // generation guard (seen) dedupes a unit that occupies several cells in the window.
	walk.seenGen += 1;
	const gen = walk.seenGen;

	for (let wy = wy0; wy <= wy1; wy++) {
		for (let wx = wx0; wx <= wx1; wx++) {
			const v = grid[wy * wW + wx];

			if (v === 0 || v === self) { continue; }
			const other = v - 1;

			if (seen[other] === gen) { continue; }
			seen[other] = gen;
			if (settledOnly && MoveTarget.active[other] === 1) { continue; }   // pass through moving traffic
			const dx = xFP - Position.x[other]; const
				dy = yFP - Position.y[other];
			const sum = rFP + unitRadiusFP(world, other);

			if (Math.abs(dx) + Math.abs(dy) < sum) { return true; }            // L1 (diamond) overlap
		}
	}

	return false;
}

/** True if a unit of L1 radius rFP could stand at (xFP,yFP): in-bounds, clear of terrain, and not
 *  overlapping any other unit's diamond. */
export function footprintFreeAt(world: SimWorld, xFP: number, yFP: number, rFP: number, selfEid: number): boolean {
	return terrainClearAt(world, xFP, yFP, rFP) && !unitOverlapAt(world, xFP, yFP, rFP, selfEid, false);
}

/** Clear of terrain only — ignores all units.  (Kept for callers that just need a static check.) */
export function footprintStaticFreeAt(world: SimWorld, xFP: number, yFP: number, rFP: number): boolean {
	return terrainClearAt(world, xFP, yFP, rFP);
}

/** Like footprintFreeAt but only *settled* (non-moving) units block — a unit flows through moving
 *  traffic (a convoy) while never overlapping a parked one.  Used for settle and for following. */
export function footprintSoftFreeAt(world: SimWorld, xFP: number, yFP: number, rFP: number, selfEid: number): boolean {
	return terrainClearAt(world, xFP, yFP, rFP) && !unitOverlapAt(world, xFP, yFP, rFP, selfEid, true);
}

/** Corner-graze terrain test: passable if just the unit's CENTRE tile is open (in-bounds, not a wall
 *  or building) — the swept-box corners are ignored.  Used ONLY by the diagonal corner-cut step in
 *  movement, where a tile-sized unit threading a diagonal pinch/stairstep must be allowed to clip the
 *  flanking wall corners (WC2 behaviour).  The centre stays in open terrain, so a unit never tunnels
 *  through a wall body — it only grazes corners while passing diagonally.  At the exact tile corner of
 *  a pinch ANY positive-radius box clips the flanking walls, so the corner-cut step can't use one. */
export function terrainCentreClearAt(world: SimWorld, xFP: number, yFP: number): boolean {
	const tx = (xFP / FP / TILE_PX) | 0;
	const ty = (yFP / FP / TILE_PX) | 0;
	const { pass, w: mapW } = world.terrain;

	if (!pass) { return true; }
	if (tx < 0 || ty < 0 || tx >= mapW || ty >= (pass.length / mapW)) { return false; }
	if (pass[ty * mapW + tx] === 1) { return false; }

	return occupant(world, tx, ty) < 0;   // open if no building occupies the centre tile
}

/** Clear of *settled* units only (terrain ignored) — the unit half of footprintSoftFreeAt.  Pairs
 *  with terrainCentreClearAt for the corner-cut step: terrain is centre-only there, but a unit must
 *  still not cut a corner straight through a parked unit. */
export function unitsSoftFreeAt(world: SimWorld, xFP: number, yFP: number, rFP: number, selfEid: number): boolean {
	return !unitOverlapAt(world, xFP, yFP, rFP, selfEid, true);
}

/** If a unit at (x,y,r) is OVERLAPPING any SETTLED unit (penetration — it phased in, or one settled
 *  onto it while it was moving), return a step that pushes it back OUT along the separation normal(s),
 *  so a unit never stays jammed inside a parked one.  Sum of per-overlap pushes (depth × centre→centre
 *  direction), capped to one tick's travel.  Zero if not overlapping.  Deterministic integer. */
export function separateFrom(world: SimWorld, xFP: number, yFP: number, rFP: number, selfEid: number): [number, number] {
	const walk = world.walk;
	const { grid, wW, wH, seen } = walk;
	const { MoveTarget, Position } = world.components;
	let px = 0; let
		py = 0;
	const reach = rFP + MAX_UNIT_RADIUS_FP;
	const wx0 = Math.max(0, Math.floor((xFP - reach) / WALK_FP));
	const wx1 = Math.min(wW - 1, Math.floor((xFP + reach) / WALK_FP));
	const wy0 = Math.max(0, Math.floor((yFP - reach) / WALK_FP));
	const wy1 = Math.min(wH - 1, Math.floor((yFP + reach) / WALK_FP));
	const self = selfEid + 1;
	walk.seenGen += 1;
	const gen = walk.seenGen;

	for (let wy = wy0; wy <= wy1; wy++) {
		for (let wx = wx0; wx <= wx1; wx++) {
			const v = grid[wy * wW + wx];

			if (v === 0 || v === self) { continue; }
			const other = v - 1;

			if (seen[other] === gen) { continue; }
			seen[other] = gen;
			if (MoveTarget.active[other] === 1) { continue; }                 // de-penetrate from PARKED units only
			const dx = xFP - Position.x[other]; const
				dy = yFP - Position.y[other];
			const sum = rFP + unitRadiusFP(world, other);
			const l1 = Math.abs(dx) + Math.abs(dy);

			if (l1 >= sum) { continue; }                                      // not overlapping
			const pen = sum - l1;
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

/** Reserve / free a unit's broad-phase footprint at its CURRENT position (its radius box). */
export function reserveUnit(world: SimWorld, eid: number): void {
	const { Position } = world.components;
	const r = unitRadiusFP(world, eid);

	paint(world, eid, Position.x[eid], Position.y[eid], r, r, eid + 1, 0);
}

export function freeUnit(world: SimWorld, eid: number): void {
	const { Position } = world.components;
	const r = unitRadiusFP(world, eid);

    // 1-cell margin so this clears every cell the unit might own, including stale shadows from an
    // unaligned footprint.  Only ever clears cells === self.
	paint(world, eid, Position.x[eid], Position.y[eid], r, r, 0, 1);
}
