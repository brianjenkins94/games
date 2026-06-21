/**
 * Pathing regression suite — building collision shape (in-process; no browser needed).
 *
 * Buildings collide as undersized OCTAGONS: the footprint inset 16px on every side (so the collision
 * sits inside the sprite's padding) with the 4 corners chamfered 16px at 45° (units round a corner).
 * These assert the shape directly via walkGrid.footprintStaticFreeAt (terrain-only), which is the test
 * the movement system uses, so they pin the octagon without needing a building-spawning scenario.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../src/game/game";
import { revealAll } from "../src/game/vision";
import { spawnBuilding } from "../src/game/world";
import { footprintStaticFreeAt } from "../src/game/walkGrid";
import { Position, Building } from "../src/game/components";

const FP = 1000, R = 16 * FP;   // a default unit's L1 radius

/** Spawn `typeId` at tile (4,4) on a 12×12 open map; return its centre + half-extents (px). */
function placeBuilding(typeId: number) {
    const g = createGame(1, { gids: Array(144).fill(1), mapW: 12, mapH: 12, terrainArr: [0, 0] });
    revealAll();
    const eid = spawnBuilding(g.world, 4, 4, 0, typeId);
    return { cx: Position.x[eid], cy: Position.y[eid], hw: Building.fw[eid] * 16 * FP, hh: Building.fh[eid] * 16 * FP };
}
const clear = (x: number, y: number) => footprintStaticFreeAt(x, y, R);

test("building: a unit cannot stand on the footprint centre", () => {
    const { cx, cy } = placeBuilding(14);   // 4×4
    assert.equal(clear(cx, cy), false);
});

test("building: 16px margin — the unit centre may reach the footprint edge but not past the inset", () => {
    const { cx, cy, hw } = placeBuilding(14);   // 4×4, hw = 64px
    assert.equal(clear(cx + hw, cy), true, "footprint edge (16px-inset octagon) is clear");
    assert.equal(clear(cx + hw - 1 * FP, cy), false, "just inside the edge is blocked");
});

test("building: corners are chamfered — a unit rounds the corner closer than a box would", () => {
    const { cx, cy, hw, hh } = placeBuilding(14);   // 4×4, hw=hh=64px
    // A point diagonally inside the box's corner (48,48 from centre, < 64 on both axes) would be BLOCKED
    // by a box, but the 16px chamfer cuts it — so the octagon leaves it clear.
    assert.equal(clear(cx + hw - 16 * FP, cy + hh - 16 * FP), true, "chamfered corner is clear");
    assert.equal(clear(cx + hw - 18 * FP, cy + hh - 18 * FP), false, "just inside the chamfer is blocked");
});

test("building: smaller footprints inset proportionally (2×2 stays solid at its core)", () => {
    const { cx, cy } = placeBuilding(10);   // 2×2 → inset leaves a 16px diamond core
    assert.equal(clear(cx, cy), false, "2×2 core still blocks at the centre");
    assert.equal(clear(cx + 33 * FP, cy), true, "well outside the small footprint is clear");
});
