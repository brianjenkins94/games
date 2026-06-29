/**
 * Tiny-map fixtures for the pathing e2e suite (dozer-style declarative grids).
 *
 * A map is rows of chars: '#' = blocked, anything else = walkable — compiled to the `mapInfo` the
 * sim consumes (gid 1 → LAND/walkable, gid 0 → blocked; see game/passability.ts). Keep these small;
 * the whole point is hand-readable scenarios the referee rebuilds via `load-scenario`.
 */

export interface MapInfo { gids: number[]; mapW: number; mapH: number; terrainArr: number[]; }

/** Build a map from rows of chars: '#' = blocked, everything else = walkable. */
export function tinyMap(rows: string[]): MapInfo {
    const mapH = rows.length;
    const mapW = rows[0].length;
    const gids: number[] = [];
    for (const row of rows) for (const ch of row) gids.push(ch === "#" ? 0 : 1);
    // terrainArr[gid]: gid 1 → class 0 (LAND, walkable); gid 0 is special-cased to blocked upstream.
    return { gids, mapW, mapH, terrainArr: [0, 0] };
}

/** A 5x5 all-walkable map. */
export const empty5 = (): MapInfo => tinyMap(["....." , ".....", ".....", ".....", "....."]);

/** A w×h all-walkable map. */
export const emptyMap = (w: number, h: number): MapInfo => tinyMap(Array.from({ length: h }, () => ".".repeat(w)));

/** Is tile (tx,ty) walkable in this map? (gid 0 = blocked; out of bounds = blocked.) */
export function isWalkable(map: MapInfo, tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= map.mapW || ty >= map.mapH) return false;
    return map.gids[ty * map.mapW + tx] !== 0;
}

/** Diagonal-gap threading: a mover crosses a 5x5 corner-to-corner in each diagonal direction, with two
 *  own-team peasants flanking the centre tile (2,2) — the orthogonal corners of its centre diagonal
 *  step — so it must thread the diagonal gap BETWEEN them (localPath's diagonal-gap rule). */
export const DIAGONAL_GAP: { dir: string; from: [number, number]; to: [number, number]; peasants: [number, number][] }[] = [
    { dir: "NE", from: [0, 4], to: [4, 0], peasants: [[3, 2], [2, 1]] },
    { dir: "SE", from: [0, 0], to: [4, 4], peasants: [[3, 2], [2, 3]] },
    { dir: "SW", from: [4, 0], to: [0, 4], peasants: [[1, 2], [2, 3]] },
    { dir: "NW", from: [4, 4], to: [0, 0], peasants: [[1, 2], [2, 1]] },
];

/** Tile index → tile-centre fixed-point (FP=1000, TILE_PX=32). */
export const tcFP = (t: number): number => t * 32000 + 16000;

/** The 8 compass directions as start→goal on a 5x5: a unit placed at `from` travels in `dir` to `to`. */
export const DIRECTIONS: { dir: string; from: [number, number]; to: [number, number] }[] = [
    { dir: "S",  from: [2, 0], to: [2, 4] },
    { dir: "N",  from: [2, 4], to: [2, 0] },
    { dir: "E",  from: [0, 2], to: [4, 2] },
    { dir: "W",  from: [4, 2], to: [0, 2] },
    { dir: "SE", from: [0, 0], to: [4, 4] },
    { dir: "NW", from: [4, 4], to: [0, 0] },
    { dir: "SW", from: [4, 0], to: [0, 4] },
    { dir: "NE", from: [0, 4], to: [4, 0] },
];
