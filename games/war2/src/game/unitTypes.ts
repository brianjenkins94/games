/**
 * Unit-type interning.
 *
 * The sim stores a unit's type as a small integer in `Unit.type` (a typed array)
 * rather than a string, both for compactness and because strings have no place in
 * the deterministic hot path.  This module is the single source of truth for the
 * `"unit-peasant" ↔ id` mapping.
 *
 * DETERMINISM: the id must be identical on both peers, because it travels in
 * SPAWN commands and snapshots.  We therefore derive ids from the *sorted* list
 * of keys in `units.json` — a pure function of the shared asset, independent of
 * object-insertion order.  id 0 is reserved for "unknown / none".
 */
import unitsJson from "../assets/units.json";
import { TILE_PX } from "./components";

export const UNIT_TYPE_NONE = 0;

// Sorted once at module load.  Index 0 is the sentinel "none"; real types are 1..N.
const _names: string[] = ["", ...Object.keys(unitsJson).sort()];
const _ids = new Map<string, number>(_names.map((name, id) => [name, id]));

/** Intern a unit-type name to its stable integer id (0 if unknown). */
export function unitTypeId(name: string): number {
    return _ids.get(name) ?? UNIT_TYPE_NONE;
}

/** Resolve an interned id back to its unit-type name ("" if none/unknown). */
export function unitTypeName(id: number): string {
    return _names[id] ?? "";
}

/** Raw definition record from units.json for a given interned id (or undefined). */
export function unitTypeDef(id: number): Record<string, unknown> | undefined {
    const name = _names[id];
    return name ? (unitsJson as Record<string, Record<string, unknown>>)[name] : undefined;
}

/** Footprint [w, h] in tiles (defaults to [1, 1]). */
export function unitFootprint(id: number): [number, number] {
    const ts = unitTypeDef(id)?.["tileSize"] as [number, number] | undefined;
    return ts ? [ts[0], ts[1]] : [1, 1];
}

/** Construction time in ticks (units.json costs.time; 0 if unspecified). */
export function unitBuildTicks(id: number): number {
    const t = (unitTypeDef(id)?.["costs"] as { time?: number } | undefined)?.time;
    return typeof t === "number" ? t : 0;
}

/** Sight radius in tiles (units.json sightRange).  Falls back to 4 (the legacy
 *  uniform radius) for unknown/none.  Measured with the dodecagonal metric. */
export function unitSight(id: number): number {
    const s = unitTypeDef(id)?.["sightRange"];
    return typeof s === "number" ? s : 4;
}

// Collision-box half-extents, in PIXELS (movement scales to FP).
// Per-unit collision size is explicit data: units.json `boxSize` [w, h] in pixels.
// Engine-agnostic on purpose — WC2 ground units are 32×32 (one tile) and ships/flyers
// 64×64, while StarCraft units use their own sub-tile boxes; none of it is derived from
// the tile footprint here.  Anything without a boxSize falls back to one tile.
const DEFAULT_BOX_HALF_PX = TILE_PX >> 1;   // one 32px tile

/** Collision-box half-extents [halfW, halfH] in PIXELS for a mobile unit type.
 *  Buildings don't use this — they collide via their grid footprint.
 *  NOTE: unit↔unit collision is now CIRCULAR (see unitRadiusPx); this box is kept for the selection
 *  ring and the terrain-footprint sweep (a unit may not stand where its box overlaps blocked ground). */
export function unitBoxHalfPx(id: number): [number, number] {
    const b = unitTypeDef(id)?.["boxSize"] as [number, number] | undefined;
    if (b) return [b[0] >> 1, b[1] >> 1];
    return [DEFAULT_BOX_HALF_PX, DEFAULT_BOX_HALF_PX];
}

// Unit↔unit collision is a DIAMOND (L1 ball); this returns its L1 "radius" in PIXELS = the cardinal
// reach (N/S/E/W).  Full tile size: the diamond is inscribed in the tile (cardinal reach = tile edge),
// so at rest units pack flush (touch edge-to-edge at 32px tile spacing) and look fully tile-filling.
// The diamond's slim diagonals are what let a unit thread the gap between two diagonally-placed units
// (movement.ts's full step does it; no temporary-shrink "squeeze" is involved — that model is gone).
export function unitRadiusPx(id: number): number {
    const b = unitTypeDef(id)?.["boxSize"] as [number, number] | undefined;
    const w = b ? b[0] : TILE_PX;
    return w >> 1;   // 32 → 16 (inscribed in the tile), 64 (ships) → 32
}
