/**
 * The maps a browser match can be played on, by name — what the referee names in its join reply and each client
 * loads. For now two small ones, drawn here as rows ('#' blocked, '.' land); the game's own Tiled maps come with the
 * assets (W3, see MIGRATION.md).
 */
import type { MapInfo } from "../sim/world.ts";

/** A map from rows of text: '#' blocked, anything else land. */
export function rowsMap(rows: string[]): MapInfo {
	return { "gids": rows.flatMap((row) => [...row].map((char) => (char === "#" ? 0 : 1))), "mapW": rows[0].length, "mapH": rows.length, "terrainArr": [0, 0] };
}

const OPEN = Array.from({ "length": 24 }, () => ".".repeat(24));

/** 32×32 with a few walls to path around, and a gap in each. */
const ARENA = Array.from({ "length": 32 }, (_, y) => Array.from({ "length": 32 }, (_, x) => {
	const wall = (x === 10 && y > 4 && y < 27 && y !== 15) || (x === 21 && y > 4 && y < 27 && y !== 16) || (y === 8 && x > 13 && x < 18);

	return wall ? "#" : ".";
}).join(""));

export const MAPS: Record<string, string[]> = { "open": OPEN, "arena": ARENA };

export function loadMap(name: string): MapInfo {
	const rows = MAPS[name];

	if (rows === undefined) {
		throw new Error(`no map called ${name}`);
	}

	return rowsMap(rows);
}
