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

/** True if the unit-type is a building (units.json `building: true`). */
export function isBuildingType(id: number): boolean {
    return unitTypeDef(id)?.["building"] === true;
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
// SC-style movement: ground units have an axis-aligned box that separates against
// other units (soft) and clamps out of buildings/terrain (hard).  units.json has no
// per-unit size today (only building `tileSize`), so default to a small uniform box;
// a future per-type `boxSize: [w, h]` override is honoured if present.
const DEFAULT_BOX_HALF_PX = 11;   // ~22px box, a touch under one 32px tile

/** Collision-box half-extents [halfW, halfH] in PIXELS for a mobile unit type.
 *  Buildings don't use this — they collide via their grid footprint. */
export function unitBoxHalfPx(id: number): [number, number] {
    const b = unitTypeDef(id)?.["boxSize"] as [number, number] | undefined;
    if (b) return [b[0] >> 1, b[1] >> 1];
    return [DEFAULT_BOX_HALF_PX, DEFAULT_BOX_HALF_PX];
}
