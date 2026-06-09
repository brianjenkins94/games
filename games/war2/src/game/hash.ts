import { Position, UnitId } from "./components";

/**
 * FNV-1a 32-bit over all unit positions, sorted by stable unitId.
 * Sorting by bitecs eid would produce different hashes after a full resync
 * where the peer recreates entities with freshly-allocated eids.
 */
export function hashEntities(eids: number[]): number {
    const sorted = eids.slice().sort((a, b) => UnitId.id[a] - UnitId.id[b]);
    let h = 2166136261; // FNV offset basis
    for (const eid of sorted) {
        h = Math.imul(h ^ (Position.x[eid] | 0), 16777619) >>> 0;
        h = Math.imul(h ^ (Position.y[eid] | 0), 16777619) >>> 0;
    }
    return h;
}
