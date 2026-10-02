/**
 * The maps a match can be played on (W3, src/browser/maps.ts): the built-in ones, and the game's own from the assets
 * mirror — here, a small Tiled map served by a stubbed fetch, so the test needs no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assetUrl } from "../src/browser/assets.ts";
import { BUILT_IN, loadGameMap, loadMap, rowsMap } from "../src/browser/maps.ts";

test("a built-in map: blocked where its rows say, drawn in the forest tileset's grass and wall, a start each side", async () => {
	const arena = await loadGameMap("arena");

	assert.deepEqual([arena.info.mapW, arena.info.mapH], [32, 32]);
	assert.deepEqual(arena.info, rowsMap(BUILT_IN["arena"]!));
	assert.deepEqual([arena.render.gids[10], arena.render.gids[5 * 32 + 10 + 32]], [357, 17], "grass, then a wall tile of column 10");
	assert.deepEqual(arena.starts, [[8, 16], [24, 16]]);
	assert.equal(await loadMap("arena"), arena.info);
});

test("the game's own map, from the mirror: its tiles, its tileset's terrain classes, its players' starts — fetched once", async () => {
	const tiled = {
		"width": 2,
		"height": 2,
		"tilesets": [{ "name": "summer", "image": "../../tilesets/forest.png", "spacing": 1, "margin": 0 }],
		"layers": [{ "type": "tilelayer", "data": [1, 2, 3, 4] }, { "type": "objectgroup" }],
		"properties": [{ "name": "p0_startX", "value": 0 }, { "name": "p0_startY", "value": 1 }, { "name": "p1_startX", "value": 1 }, { "name": "p1_startY", "value": 0 }]
	};
	const asked: string[] = [];
	const real = globalThis.fetch;

	globalThis.fetch = (async (url: string) => {
		asked.push(url);

		return url.endsWith("missing.json") ? new Response("", { "status": 404 }) : Response.json(tiled);
	}) as typeof fetch;

	try {
		const map = await loadGameMap("ladder/Test map");

		assert.equal((await loadGameMap("ladder/Test map")), map);
		assert.deepEqual(asked, [assetUrl("maps/ladder/Test map.json")], "fetched once, its name encoded");
		assert.deepEqual([map.info.gids, map.info.mapW, map.render.tileset, map.render.spacing], [[1, 2, 3, 4], 2, "summer", 1]);
		assert.ok(map.info.terrainArr.length > 0, "summer's terrain classes, as forest's");
		assert.equal(map.render.tilesetUrl, assetUrl("tilesets/forest.png"));
		assert.deepEqual(map.starts, [[0, 1], [1, 0]]);
		await assert.rejects(loadGameMap("ladder/missing"), /no map called ladder\/missing \(404\)/u);
	} finally {
		globalThis.fetch = real;
	}
});
