/**
 * Pathing regression suite — building collision shape (in-process; no browser needed).
 *
 * Buildings collide as undersized OCTAGONS: the footprint inset 8px on every side (so the collision
 * sits inside the sprite's padding — a unit may overlap a building edge by ~8px) with the 4 corners
 * chamfered 8px at 45° (units round a corner).  These assert the shape directly via
 * walkGrid.footprintStaticFreeAt (terrain-only) — the test the movement system uses — on real war2
 * footprints: 2×2 (farm) and 3×3 (barracks).  (War2 buildings are all 2×2 or 3×3.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../src/game/game";
import { revealAll } from "../src/game/vision";
import { spawnBuilding } from "../src/game/world";
import { footprintStaticFreeAt } from "../src/game/walkGrid";
import { Position, Building, UnitId } from "../src/game/components";
import { CmdType } from "../src/net/protocol";

const FP = 1000, R = 16 * FP;   // a default unit's L1 radius
const FARM = 37, BARRACKS = 49; // 2×2, 3×3 footprints

/** Spawn `typeId` at tile (4,4) on a 12×12 open map; return its centre + half-extents (px·FP). */
function placeBuilding(typeId: number) {
    const g = createGame(1, { gids: Array(144).fill(1), mapW: 12, mapH: 12, terrainArr: [0, 0] });
    revealAll();
    const eid = spawnBuilding(g.world, 4, 4, 0, typeId);
    return { cx: Position.x[eid], cy: Position.y[eid], hw: Building.fw[eid] * 16 * FP, hh: Building.fh[eid] * 16 * FP };
}
const clear = (x: number, y: number) => footprintStaticFreeAt(x, y, R);

test("building: a unit cannot stand on the footprint centre (2×2 farm)", () => {
    const { cx, cy } = placeBuilding(FARM);
    assert.equal(clear(cx, cy), false);
});

test("building: 8px margin — the unit centre is kept 8px outside the footprint edge", () => {
    const { cx, cy, hw } = placeBuilding(FARM);   // 2×2, hw = 32px
    // Octagon inset 8px → cardinal collision boundary = footprint edge + (radius − inset) = hw + 8px.
    assert.equal(clear(cx + hw + 8 * FP, cy), true,  "8px beyond the footprint edge is clear");
    assert.equal(clear(cx + hw + 7 * FP, cy), false, "within 8px of the footprint edge is blocked");
});

test("building: corners are chamfered 8px — a unit rounds the corner closer than a box would", () => {
    const { cx, cy } = placeBuilding(BARRACKS);   // 3×3, hw = hh = 48px
    // Box-half each axis = hw + 8 = 56px; a box would block out to (56,56).  The 8px chamfer cuts the
    // diagonal: a point is clear once dx+dy reaches (hw+8)+(hh+8)−8 = 88px, even with dx,dy < 56.
    assert.equal(clear(cx + 44 * FP, cy + 44 * FP), true,  "chamfered corner (44,44 → sum 88) is clear");
    assert.equal(clear(cx + 43 * FP, cy + 43 * FP), false, "just inside the chamfer (sum 86) is blocked");
});

test("building: smaller 2×2 footprint still blocks its core but clears just outside", () => {
    const { cx, cy, hw } = placeBuilding(FARM);   // 2×2, hw = 32px
    assert.equal(clear(cx, cy), false, "2×2 core blocks at the centre");
    assert.equal(clear(cx + hw + 16 * FP, cy), true, "well outside the small footprint is clear");
});

const tc = (t: number) => t * 32 * FP + 16 * FP;   // tile-centre fixed-point

// Regression: component arrays are module-global and bitecs recycles eids, so a unit that lands on an
// eid a building previously held must NOT inherit its building-ness — else it renders as a building and
// the movement system skips it (it never moves).  Guards both the spawnUnit clear and the hasComponent
// "is a building" checks (see world.ts / movement.ts).
test("building: a unit on an eid recycled from a building is not treated as a building", () => {
    const g = createGame(1, { gids: Array(144).fill(1), mapW: 12, mapH: 12, terrainArr: [0, 0] });
    revealAll();
    g.initUnitIdCounter(0);
    const beid = spawnBuilding(g.world, 4, 4, 0, FARM);   // claims an eid + sets Building.fw
    g.despawnUnit(beid);                                  // free it for reuse
    const ueid = g.spawnUnit(tc(0), tc(0), 0);           // recycles that eid
    assert.equal(ueid, beid, "precondition: the building's eid was recycled");
    assert.equal(Building.fw[ueid], 0, "recycled unit cleared the stale Building.fw");

    // It must actually move when ordered — a unit wrongly seen as a building would be skipped and stuck.
    g.applyCommands([{ type: CmdType.MOVE, unitIds: [UnitId.id[ueid]], txFP: tc(0), tyFP: tc(10) }]);
    const y0 = Position.y[ueid];
    for (let i = 0; i < 80; i++) g.step();
    assert.ok(Position.y[ueid] > y0, "recycled unit moved (not skipped as a static building)");
});
