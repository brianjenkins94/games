/**
 * The maps a match can be played on, by name — what the referee names in its join reply, and each client and
 * instance loads for itself. Two kinds:
 *
 * - **Built in**, drawn here as rows ('#' blocked, '.' land): `open` and `arena`. They render on the forest tileset's
 *   plain grass and stone wall, as the old war2 drew its scenarios.
 * - **The game's own**, from the assets mirror (assets.ts) by path, e.g. `ladder/Plains of snow BNE` (the map the old
 *   war2 booted on): a Tiled map, its tileset's terrain classes from `terrain.json`, its players' start positions from
 *   its properties.
 */
import type { MapInfo } from "./sim/world.ts";
import terrainJson from "./data/terrain.json" with { "type": "json" };
import { assetUrl } from "./assets.ts";

/** A map, as the sim needs it and as the renderer draws it. */
export interface GameMap {
	"name": string;
	"info": MapInfo;
	"render": {
		/** Tileset frame + 1 per tile (Tiled gids). */
		"gids": number[];
		/** The tileset's name (picks building art: units.json `files`), and its sheet. */
		"tileset": string;
		"tilesetUrl": string;
		"spacing": number;
		"margin": number;
	};
	/** Each player's start, in tiles (as many as the map defines). */
	"starts": [number, number][];
}

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

export const BUILT_IN: Record<string, string[]> = { "open": OPEN, "arena": ARENA };

// The forest tileset's plain grass and stone wall, as gids (the old war2's scenario terrain).
const GRASS = 357;
const WALL = 17;

const TERRAIN = terrainJson as unknown as Record<string, number[]>;
const cache = new Map<string, Promise<GameMap>>();

function builtIn(name: string, rows: string[]): GameMap {
	const info = rowsMap(rows);
	const w = info.mapW;

	return {
		"name": name,
		"info": info,
		"render": { "gids": info.gids.map((gid) => (gid === 0 ? WALL : GRASS)), "tileset": "forest", "tilesetUrl": assetUrl("tilesets/forest.png"), "spacing": 1, "margin": 0 },
		// Each team in its own band (see the referee's setup): left and right of centre.
		"starts": [[Math.floor(w / 4), Math.floor(info.mapH / 2)], [Math.floor((3 * w) / 4), Math.floor(info.mapH / 2)]]
	};
}

async function fromMirror(name: string): Promise<GameMap> {
	const response = await fetch(assetUrl(`maps/${name}.json`));

	if (!response.ok) {
		throw new Error(`no map called ${name} (${response.status})`);
	}

	const tiled = await response.json() as { "width": number; "height": number; "tilesets": { "name": string; "image": string; "spacing"?: number; "margin"?: number }[]; "layers": { "type": string; "data"?: number[] }[]; "properties"?: { "name": string; "value": unknown }[] };
	const [tileset] = tiled.tilesets;
	const gids = tiled.layers.find((layer) => layer.type === "tilelayer").data;
	const property = (key: string): number | undefined => {
		const value = tiled.properties?.find((candidate) => candidate.name === key)?.value;

		return typeof value === "number" ? value : undefined;
	};
	const starts: [number, number][] = [];

	for (let player = 0; property(`p${player}_startX`) !== undefined; player += 1) {
		starts.push([property(`p${player}_startX`), property(`p${player}_startY`)]);
	}

	return {
		"name": name,
		// (As the old client: "summer" reads as "forest" in terrain.json.)
		"info": { "gids": gids, "mapW": tiled.width, "mapH": tiled.height, "terrainArr": TERRAIN[tileset.name.replace("summer", "forest")] ?? [] },
		"render": { "gids": gids, "tileset": tileset.name, "tilesetUrl": assetUrl(`tilesets/${tileset.image.split("/").pop()}`), "spacing": tileset.spacing ?? 0, "margin": tileset.margin ?? 0 },
		"starts": starts
	};
}

/** The map called `name`: built in, or fetched from the mirror (once per realm). */
export async function loadGameMap(name: string): Promise<GameMap> {
	if (!cache.has(name)) {
		const rows = BUILT_IN[name];

		cache.set(name, rows === undefined ? fromMirror(name) : Promise.resolve(builtIn(name, rows)));
	}

	return cache.get(name);
}

/** The sim's form of map `name` (what a client's `loadMap` gives). */
export async function loadMap(name: string): Promise<MapInfo> {
	return (await loadGameMap(name)).info;
}
