/**
 * Passability — derive a walkable/blocked flag per tile from the map's GID
 * array and the terrain.json class lookup.
 *
 * Currently only handles land units (LAND + COAST = walkable).
 * Extend to accept a UnitType enum when naval / air units are added.
 */

// Terrain class values from terrain.json
const LAND       = 0;
const WATER      = 1;
const COAST      = 2;
// IMPASSABLE = 3

let _pass: Uint8Array | null = null;
let _mapW = 0;
let _mapH = 0;

/**
 * Build the passability array from the tile layer GID data.
 *
 * @param gids       Flat GID array from the map's tile layer (1-based, 0=empty)
 * @param mapW       Map width in tiles
 * @param mapH       Map height in tiles
 * @param terrainArr terrain.json[tilesetName] — indexed by GID, value = terrain class
 */
export function initPassability(
    gids:       number[],
    mapW:       number,
    mapH:       number,
    terrainArr: number[],
): void {
    _mapW = mapW;
    _mapH = mapH;
    _pass = new Uint8Array(mapW * mapH); // 0 = walkable, 1 = blocked

    for (let i = 0; i < gids.length; i++) {
        const gid = gids[i];
        if (gid === 0) { _pass[i] = 1; continue; }        // empty tile → blocked
        const cls = terrainArr[gid] ?? 3;                  // unknown → impassable
        _pass[i] = (cls === LAND || cls === COAST) ? 0 : 1;
    }
}

export function getPassability(): Uint8Array { return _pass!; }
export function getMapW():        number     { return _mapW;  }
export function getMapH():        number     { return _mapH;  }
