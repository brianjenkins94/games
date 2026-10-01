/**
 * The oracle's scenarios, as plain data any sim can run: a map, what's on it, and a script of commands at given
 * ticks. Units are referred to by their index in `spawns` and buildings by their index in `buildings` — each adapter
 * maps those to its own ids — and types by name.
 *
 * The hand-written ones are the old test suite's setups (directions, diagonal gaps, groups, a pinch corridor, routing
 * around a building, production with rally and cancel, building placement). The random ones are seeded command
 * scripts on a real map with fog on: lots of interleaved moves, queued moves, stops and builds by both teams.
 */
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";

export interface TinyMap { "rows": string[] }
export interface TiledMap { "tiled": string }
export type MapSpec = TinyMap | TiledMap;

/** A map as the sim consumes it: gid per tile, and the tileset's terrain class per gid (0 = land). */
export interface MapInfo { "gids": number[]; "mapW": number; "mapH": number; "terrainArr": number[] }

export interface Spawn { "type": string; "tile": [number, number]; "team"?: number }
export interface BuildingSpawn { "type": string; "tile": [number, number]; "team"?: number }

export type ScriptCommand = { "at": number; "team"?: number } & (
	| { "move": number[]; "to": [number, number]; "queue"?: boolean }
	| { "stop": number[]; "queue"?: boolean }
	| { "produce": number; "type": string }
	| { "rally": number; "to": [number, number] }
	| { "cancel": number; "index": number }
	| { "build": string; "tile": [number, number] }
);

export interface Scenario {
	"name": string;
	"map": MapSpec;
	/** Fog on (the real game), or the whole map revealed (the old suite's scenarios). */
	"fog": boolean;
	"seed": number;
	"spawns": Spawn[];
	/** Placed finished. */
	"buildings": BuildingSpawn[];
	"script": ScriptCommand[];
	"ticks": number;
}

const ASSETS = path.resolve(import.meta.dirname, "../../legacy/src/assets");

/** A map's sim form: a tiny map's rows ('#' blocked, anything else land), or a Tiled map from the assets. */
export function mapInfo(map: MapSpec): MapInfo {
	if ("rows" in map) {
		return { "gids": map.rows.flatMap((row) => [...row].map((char) => (char === "#" ? 0 : 1))), "mapW": map.rows[0]!.length, "mapH": map.rows.length, "terrainArr": [0, 0] };
	}

	const tiled = JSON.parse(fs.readFileSync(path.join(ASSETS, "maps", map.tiled + ".json")));
	const terrain = JSON.parse(fs.readFileSync(path.join(ASSETS, "terrain.json"))) as Record<string, number[]>;
	// (As the old client: its first tileset, "summer" read as "forest".)
	const tileset = String(tiled.tilesets?.[0]?.name ?? "winter").replace("summer", "forest");

	return { "gids": tiled.layers.find((layer: { "type": string }) => layer.type === "tilelayer").data, "mapW": tiled.width, "mapH": tiled.height, "terrainArr": terrain[tileset] ?? [] };
}

function isLand(info: MapInfo, tx: number, ty: number): boolean {
	const gid = info.gids[ty * info.mapW + tx];

	return tx >= 0 && ty >= 0 && tx < info.mapW && ty < info.mapH && gid !== undefined && gid !== 0 && (info.terrainArr[gid] ?? 0) === 0;
}

const open = (w: number, h: number): TinyMap => ({ "rows": Array.from({ "length": h }, () => ".".repeat(w)) });

/** mulberry32: the scripts' seeded randomness. */
function rng(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;

		let t = state;

		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const DIRECTIONS: [string, [number, number], [number, number]][] = [
	["S", [2, 0], [2, 4]], ["N", [2, 4], [2, 0]], ["E", [0, 2], [4, 2]], ["W", [4, 2], [0, 2]],
	["SE", [0, 0], [4, 4]], ["NW", [4, 4], [0, 0]], ["SW", [4, 0], [0, 4]], ["NE", [0, 4], [4, 0]]
];

const DIAGONAL_GAP: [string, [number, number], [number, number], [number, number][]][] = [
	["NE", [0, 4], [4, 0], [[3, 2], [2, 1]]], ["SE", [0, 0], [4, 4], [[3, 2], [2, 3]]],
	["SW", [4, 0], [0, 4], [[1, 2], [2, 3]]], ["NW", [4, 4], [0, 0], [[1, 2], [2, 1]]]
];

/** A block of `count` units of `type`, row by row from `corner`, `width` to a row. */
function block(type: string, corner: [number, number], count: number, width: number, team = 0): Spawn[] {
	return Array.from({ "length": count }, (_, index) => ({ "type": type, "tile": [corner[0] + (index % width), corner[1] + Math.floor(index / width)] as [number, number], "team": team }));
}

const indices = (from: number, count: number): number[] => Array.from({ "length": count }, (_, index) => from + index);

/** A seeded random script on a real map: both teams' units (spawned in two clusters) moved, queued, stopped, and
 *  building farms, around their starts and across to each other's. */
function randomScenario(name: string, seed: number, ticks: number): Scenario {
	const map: TiledMap = { "tiled": "ladder/Plains of snow BNE" };
	const info = mapInfo(map);
	const tiled = JSON.parse(fs.readFileSync(path.join(ASSETS, "maps", map.tiled + ".json")));
	const prop = (key: string, fallback: number): number => tiled.properties?.find((entry: { "name": string }) => entry.name === key)?.value ?? fallback;
	const starts: [number, number][] = [[prop("p0_startX", 32), prop("p0_startY", 32)], [prop("p1_startX", 96), prop("p1_startY", 96)]];
	const perTeam = 6;
	const random = rng(seed);
	const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
	// Land tiles near a point (and some of them, across at the other start).
	const landNear = (centre: [number, number], radius: number): [number, number] => {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const tile: [number, number] = [centre[0] + Math.floor((random() * 2 - 1) * radius), centre[1] + Math.floor((random() * 2 - 1) * radius)];

			if (isLand(info, tile[0], tile[1])) {
				return tile;
			}
		}

		return centre;
	};
	const spawns: Spawn[] = [0, 1].flatMap((team) => Array.from({ "length": perTeam }, (_, index) => ({ "type": team === 0 ? "unit-peasant" : "unit-peon", "tile": landNear(starts[team]!, 3), "team": team })));
	const script: ScriptCommand[] = [];

	for (let at = 5; at < ticks - 200; at += 20 + Math.floor(random() * 50)) {
		const team = random() < 0.5 ? 0 : 1;
		const own = indices(team * perTeam, perTeam).filter(() => random() < 0.6);
		const units = own.length > 0 ? own : [team * perTeam];
		const roll = random();

		if (roll < 0.08) {
			script.push({ "at": at, "team": team, "stop": units });
		} else if (roll < 0.14) {
			script.push({ "at": at, "team": team, "build": team === 0 ? "unit-farm" : "unit-pig-farm", "tile": landNear(starts[team]!, 10) });
		} else {
			// Mostly around home; sometimes across the map, into the other team.
			const target = random() < 0.25 ? landNear(starts[1 - team]!, 12) : landNear(pick(starts), 20);

			script.push({ "at": at, "team": team, "move": units, "to": target, ...random() < 0.25 ? { "queue": true } : {} });
		}
	}

	return { "name": name, "map": map, "fog": true, "seed": 0xC0FFEE, "spawns": spawns, "buildings": [], "script": script, "ticks": ticks };
}

export const SCENARIOS: Scenario[] = [
	// One unit, each of the 8 directions, across an open 5×5.
	...DIRECTIONS.map(([dir, from, to]): Scenario => ({ "name": `direction-${dir}`, "map": open(5, 5), "fog": false, "seed": 1, "spawns": [{ "type": "unit-footman", "tile": from }], "buildings": [], "script": [{ "at": 0, "move": [0], "to": to }], "ticks": 200 })),
	// Threading the diagonal gap between two own-team peasants flanking the centre.
	...DIAGONAL_GAP.map(([dir, from, to, flank]): Scenario => ({ "name": `diagonal-gap-${dir}`, "map": open(5, 5), "fog": false, "seed": 1, "spawns": [{ "type": "unit-footman", "tile": from }, ...flank.map((tile) => ({ "type": "unit-peasant", "tile": tile }))], "buildings": [], "script": [{ "at": 0, "move": [0], "to": to }], "ticks": 200 })),
	// A 3×3 group across an open field; the same move again (formation vs converge: the lastMove memo); queued moves.
	{
		"name": "group-open",
		"map": open(24, 16),
		"fog": false,
		"seed": 1,
		"spawns": block("unit-footman", [1, 6], 9, 3),
		"buildings": [],
		"script": [
			{ "at": 0, "move": indices(0, 9), "to": [20, 8] },
			{ "at": 200, "move": indices(0, 9), "to": [20, 8] },
			{ "at": 260, "move": indices(0, 5), "to": [4, 2] },
			{ "at": 261, "move": indices(0, 5), "to": [4, 13], "queue": true },
			{ "at": 262, "move": indices(5, 4), "to": [12, 8] },
			{ "at": 400, "stop": indices(0, 9) },
			{ "at": 420, "move": indices(0, 9), "to": [2, 2] }
		],
		"ticks": 900
	},
	// Six units through a one-tile gap in a wall and back (the pinch corridor: Path's wp* state).
	{
		"name": "pinch-corridor",
		"map": { "rows": Array.from({ "length": 12 }, (_, y) => Array.from({ "length": 20 }, (_, x) => (x === 10 && y !== 6 ? "#" : ".")).join("")) },
		"fog": false,
		"seed": 1,
		"spawns": block("unit-footman", [2, 4], 6, 3),
		"buildings": [],
		"script": [
			{ "at": 0, "move": indices(0, 6), "to": [16, 6] },
			{ "at": 350, "move": indices(0, 6), "to": [3, 2] },
			{ "at": 351, "move": indices(0, 3), "to": [17, 10], "queue": true }
		],
		"ticks": 1000
	},
	// A group around a barracks standing between it and its goal.
	{
		"name": "around-building",
		"map": open(16, 12),
		"fog": false,
		"seed": 1,
		"spawns": block("unit-footman", [1, 4], 6, 2),
		"buildings": [{ "type": "unit-human-barracks", "tile": [6, 4] }],
		"script": [{ "at": 0, "move": indices(0, 6), "to": [13, 5] }, { "at": 300, "move": indices(0, 6), "to": [1, 10] }],
		"ticks": 700
	},
	// Both teams training from barracks, rallying, and cancelling one in the queue.
	{
		"name": "production-rally",
		"map": open(16, 16),
		"fog": false,
		"seed": 1,
		"spawns": [],
		"buildings": [{ "type": "unit-human-barracks", "tile": [2, 2], "team": 0 }, { "type": "unit-orc-barracks", "tile": [10, 10], "team": 1 }],
		"script": [
			{ "at": 1, "produce": 0, "type": "unit-footman" },
			{ "at": 1, "produce": 0, "type": "unit-footman" },
			{ "at": 1, "produce": 0, "type": "unit-footman" },
			{ "at": 1, "produce": 1, "type": "unit-grunt" },
			{ "at": 2, "produce": 1, "type": "unit-grunt" },
			{ "at": 5, "rally": 0, "to": [13, 2] },
			{ "at": 6, "rally": 1, "to": [2, 13] },
			{ "at": 10, "cancel": 0, "index": 1 }
		],
		"ticks": 2500
	},
	// Building farms (one on a free spot, one overlapping it: refused) and a group pathing past the site.
	{
		"name": "build-farm",
		"map": open(16, 12),
		"fog": false,
		"seed": 1,
		"spawns": block("unit-peasant", [1, 3], 4, 2),
		"buildings": [],
		"script": [
			{ "at": 1, "team": 0, "build": "unit-farm", "tile": [7, 5] },
			{ "at": 2, "team": 0, "build": "unit-farm", "tile": [8, 5] },
			{ "at": 10, "move": indices(0, 4), "to": [14, 6] }
		],
		"ticks": 600
	},
	// Seeded random play on a real map, fog on.
	randomScenario("random-plains-1", 1, 3000),
	randomScenario("random-plains-2", 2, 3000),
	randomScenario("random-plains-3", 3, 3000)
];
