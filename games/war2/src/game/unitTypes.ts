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
