/**
 * One collision shape for everything (W6, see MIGRATION.md): an axis-aligned box with its corners cut at 45° — an
 * octagon — given by a half-width `w`, a half-height `h` and a corner bound `d`. A point (dx, dy) from its centre is
 * inside when |dx| < w, |dy| < h and |dx| + |dy| < d. No cut (d = w + h) is a box; a full cut (d = w = h) is a diamond,
 * the N/S/E/W sides shrunk to nothing.
 *
 * Two of them overlap exactly when their centres' offset is inside their SUM — w, h and d each added — which is the
 * same kind of shape. So every pair (unit and unit, unit and wall, unit and building) is one closed-form test of three
 * integer compares, and a planner's C-space is each obstacle grown by the mover's shape, the same test. Strict: shapes
 * that only touch don't overlap.
 *
 * Today's shapes, all special cases: a unit is a diamond (L1 radius half its box — 16 px for 32×32); a wall tile is the
 * diamond inscribed in the tile (so corners pass); a building is its footprint inset 8 px with 8 px corners cut. All in
 * fixed point (FP).
 */
import { FP, TILE_PX } from "./components.ts";
import { UNIT_TYPE_COUNT, unitRadiusPx } from "./unitTypes.ts";

export interface Shape {
	/** Half-width. */
	"w": number;
	/** Half-height. */
	"h": number;
	/** Corner bound: |dx| + |dy| < d. */
	"d": number;
}

/** A diamond of L1 radius `r`. */
export function diamond(r: number): Shape {
	return { "w": r, "h": r, "d": r };
}

/** A `w` × `h` half-extent box with its corners cut by `cut` (along each edge): d = w + h − cut, at least 0. */
export function chamfered(w: number, h: number, cut: number): Shape {
	return { "w": w, "h": h, "d": Math.max(0, w + h - cut) };
}

/** `a` and `b` summed: the shape a point (one's centre) must be inside for the two to overlap — a C-space obstacle. */
export function sum(a: Shape, b: Shape): Shape {
	return { "w": a.w + b.w, "h": a.h + b.h, "d": a.d + b.d };
}

/** `shape` shrunk by `by` on every side — or grown, for a negative `by`. */
export function inset(shape: Shape, by: number): Shape {
	return { "w": shape.w - by, "h": shape.h - by, "d": shape.d - by };
}

/** True if (dx, dy) is inside the shape given by w, h and d — or, for summed bounds, if two shapes that far apart
 *  overlap. The one test every collision comes down to. */
export function inside(w: number, h: number, d: number, dx: number, dy: number): boolean {
	const ax = dx < 0 ? -dx : dx;
	const ay = dy < 0 ? -dy : dy;

	return ax < w && ay < h && ax + ay < d;
}

/** True if `a` and `b`, centres (dx, dy) apart, overlap. */
export function overlaps(a: Shape, b: Shape, dx: number, dy: number): boolean {
	return inside(a.w + b.w, a.h + b.h, a.d + b.d, dx, dy);
}

/** How deep `a` and `b`, centres (dx, dy) apart, overlap: the least distance by which any of their summed bounds is
 *  exceeded — positive when they overlap, zero or less when they don't. */
export function depth(a: Shape, b: Shape, dx: number, dy: number): number {
	const ax = dx < 0 ? -dx : dx;
	const ay = dy < 0 ? -dy : dy;

	return Math.min(a.w + b.w - ax, a.h + b.h - ay, a.d + b.d - ax - ay);
}

/** How far two UNITS may overlap before they collide: each unit's shape is taken this much smaller against another
 *  unit (not against terrain or buildings).  Without it the gap between two units parked diagonally is a line of zero
 *  width — enterable only by landing on it exactly, which a step almost never does, so a unit off it by a pixel slid
 *  to and fro across it for good (W6 step 5).  With it the gap is 2 × this wide; units at rest may overlap as much. */
export const UNIT_SLACK = 2 * FP;

/** True if units `a` and `b`, centres (dx, dy) apart, overlap — each taken UNIT_SLACK smaller (see there). */
export function unitsOverlap(a: Shape, b: Shape, dx: number, dy: number): boolean {
	return inside(a.w + b.w - 2 * UNIT_SLACK, a.h + b.h - 2 * UNIT_SLACK, a.d + b.d - 2 * UNIT_SLACK, dx, dy);
}

/** How deep units `a` and `b` overlap, each taken UNIT_SLACK smaller: positive when they do. */
export function unitsDepth(a: Shape, b: Shape, dx: number, dy: number): number {
	return depth(a, b, dx, dy) - 2 * UNIT_SLACK;
}

const HALF_TILE_FP = (TILE_PX >> 1) * FP;
/** A building's footprint inset, and its corner cut. */
const BUILD_MARGIN_FP = 8 * FP;

/** A point: overlapping it is containing the other shape's centre. */
export const POINT: Readonly<Shape> = { "w": 0, "h": 0, "d": 0 };

/** A wall tile: the diamond inscribed in it, so a unit passes its corners and threads a diagonal pinch. */
export const WALL: Shape = diamond(HALF_TILE_FP);

/** The planner's assumed mover for the shared C-space: a one-tile land unit. */
export const TILE_MOVER: Shape = diamond(HALF_TILE_FP);

// Constant tables, built once and never written (the sim keeps no state of its own — sim.test.ts): every unit type's
// shape, and every building footprint's up to MAX_FOOTPRINT tiles a side — so the hot collision loops look shapes up
// rather than make them.
const UNIT_SHAPES: readonly Readonly<Shape>[] = Array.from({ "length": UNIT_TYPE_COUNT }, (_, typeId) => Object.freeze(diamond(unitRadiusPx(typeId) * FP)));
const MAX_FOOTPRINT = 8;
const BUILDING_SHAPES: readonly Readonly<Shape>[] = Array.from({ "length": (MAX_FOOTPRINT + 1) ** 2 }, (_, index) => Object.freeze(footprintShape(Math.floor(index / (MAX_FOOTPRINT + 1)), index % (MAX_FOOTPRINT + 1))));

function footprintShape(fw: number, fh: number): Shape {
	return chamfered(Math.max(0, fw * HALF_TILE_FP - BUILD_MARGIN_FP), Math.max(0, fh * HALF_TILE_FP - BUILD_MARGIN_FP), BUILD_MARGIN_FP);
}

/** A unit type's shape: a diamond of L1 radius half its box (units.json `boxSize`; a tile without one). */
export function unitShape(typeId: number): Readonly<Shape> {
	return UNIT_SHAPES[typeId] ?? UNIT_SHAPES[0];
}

/** A building's shape, from its footprint in tiles: the footprint inset 8 px (the structure inside its sprite's
 *  padding), corners cut 8 px, so units round its corners. */
export function buildingShape(fw: number, fh: number): Readonly<Shape> {
	return fw <= MAX_FOOTPRINT && fh <= MAX_FOOTPRINT ? BUILDING_SHAPES[fw * (MAX_FOOTPRINT + 1) + fh] : footprintShape(fw, fh);
}
