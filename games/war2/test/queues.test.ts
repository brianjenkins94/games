/**
 * Unit action queues + building production queues (in-process; no browser).
 *
 * Exercises the deterministic sim half of the feature directly through createGame + applyCommands:
 *   • a building trains a queued unit after its build time, on the producing team, then advances;
 *   • a rallied building sends the trained unit walking toward the rally point;
 *   • shift-queued move orders are visited in order;
 *   • takeSnapshot → applySnapshot round-trips the queue state (determinism / resync);
 *   • despawn clears a uid's queue state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../src/game/game";
import { revealAll } from "../src/game/vision";
import { spawnBuilding } from "../src/game/world";
import { Building, Unit, UnitId, Position, FP, TILE_PX, tileCenterFP } from "../src/game/components";
import { unitTypeId } from "../src/game/unitTypes";
import { distance } from "../src/game/distance";
import { CmdType } from "../src/net/protocol";

const BARRACKS = unitTypeId("unit-human-barracks");   // 3×3 building that trains footmen
const FOOTMAN  = unitTypeId("unit-footman");

/** Open 12×12 map, fully revealed (fog off). */
function game12() {
    const g = createGame(1, { gids: Array(144).fill(1), mapW: 12, mapH: 12, terrainArr: [0, 0] });
    revealAll();
    return g;
}
/** A finished (buildLeft = 0) barracks at footprint top-left (tx,ty); returns its stable uid. */
function completedBarracks(g: ReturnType<typeof createGame>, tx: number, ty: number, team = 0): number {
    const beid = spawnBuilding(g.world, tx, ty, team, BARRACKS);
    Building.buildLeft[beid] = 0;
    return UnitId.id[beid];
}
const countType = (g: ReturnType<typeof createGame>, typeId: number) =>
    [...g.unitEids()].filter(e => Unit.type[e] === typeId).length;

test("production: a queued unit spawns after its build time, on the producing team", () => {
    const g = game12();
    const buid = completedBarracks(g, 4, 4, 0);
    g.applyCommands([{ type: CmdType.PRODUCE, buildingUid: buid, productTypeId: FOOTMAN, team: 0 }]);

    const total = g.world.production![buid].ticksTotal;
    assert.ok(total >= 1, "head item has a countdown");

    for (let i = 0; i < total; i++) g.step();
    assert.equal(countType(g, FOOTMAN), 0, "nothing spawns until the countdown elapses");

    g.step();   // countdown now at 0 → spawns this tick
    assert.equal(countType(g, FOOTMAN), 1, "footman trained");
    const feid = [...g.unitEids()].find(e => Unit.type[e] === FOOTMAN)!;
    assert.equal(Unit.team[feid], 0, "trained on the producing team");
    assert.equal(g.world.production![buid], undefined, "queue drained");
});

test("production: a second queued unit starts only after the first completes", () => {
    const g = game12();
    const buid = completedBarracks(g, 4, 4, 0);
    g.applyCommands([
        { type: CmdType.PRODUCE, buildingUid: buid, productTypeId: FOOTMAN, team: 0 },
        { type: CmdType.PRODUCE, buildingUid: buid, productTypeId: FOOTMAN, team: 0 },
    ]);
    assert.equal(g.world.production![buid].queue.length, 2, "both queued");
    const total = g.world.production![buid].ticksTotal;

    for (let i = 0; i < total + 1; i++) g.step();   // first completes
    assert.equal(countType(g, FOOTMAN), 1, "first trained");
    const p = g.world.production![buid];
    assert.equal(p.queue.length, 1, "one left in queue");
    assert.equal(p.ticksLeft, p.ticksTotal, "second item's countdown (re)started");

    for (let i = 0; i < total + 1; i++) g.step();   // second completes
    assert.equal(countType(g, FOOTMAN), 2, "second trained");
    assert.equal(g.world.production![buid], undefined, "queue fully drained");
});

test("production: a rallied building sends trained units toward the rally point", () => {
    const g = game12();
    const buid = completedBarracks(g, 4, 4, 0);
    const rx = tileCenterFP(10), ry = tileCenterFP(10);
    g.applyCommands([{ type: CmdType.SET_RALLY, buildingUid: buid, txFP: rx, tyFP: ry, team: 0 }]);
    g.applyCommands([{ type: CmdType.PRODUCE, buildingUid: buid, productTypeId: FOOTMAN, team: 0 }]);

    const total = g.world.production![buid].ticksTotal;
    for (let i = 0; i < total + 1; i++) g.step();
    const feid = [...g.unitEids()].find(e => Unit.type[e] === FOOTMAN)!;
    const d0 = distance(Position.x[feid] - rx, Position.y[feid] - ry);

    for (let i = 0; i < 60; i++) g.step();
    const d1 = distance(Position.x[feid] - rx, Position.y[feid] - ry);
    assert.ok(d1 < d0, "rallied unit moved closer to the rally point");
});

test("action queue: shift-queued moves are visited in order", () => {
    const g = game12();
    const ueid = g.spawnUnit(tileCenterFP(1), tileCenterFP(1), 0);
    const uid = UnitId.id[ueid];
    const wp1x = tileCenterFP(3), wp1y = tileCenterFP(3);
    const wp2x = tileCenterFP(9), wp2y = tileCenterFP(9);

    g.applyCommands([{ type: CmdType.MOVE, unitIds: [uid], txFP: wp1x, tyFP: wp1y }]);                 // live move
    g.applyCommands([{ type: CmdType.MOVE, unitIds: [uid], txFP: wp2x, tyFP: wp2y, queue: true }]);    // shift-queued
    assert.equal(g.world.orders![uid].length, 1, "wp2 waits behind the live move");

    let reachedWp1 = false;
    for (let i = 0; i < 600; i++) {
        g.step();
        if (distance(Position.x[ueid] - wp1x, Position.y[ueid] - wp1y) < TILE_PX * FP) reachedWp1 = true;
    }
    assert.ok(reachedWp1, "passed through wp1 first");
    assert.ok(distance(Position.x[ueid] - wp2x, Position.y[ueid] - wp2y) < TILE_PX * FP, "ended at wp2");
    assert.equal(g.world.orders?.[uid], undefined, "queue drained");
});

test("snapshot round-trip preserves orders / production / rally", () => {
    const g = game12();
    const buid = completedBarracks(g, 4, 4, 0);
    g.applyCommands([
        { type: CmdType.SET_RALLY, buildingUid: buid, txFP: 100, tyFP: 200, team: 0 },
        { type: CmdType.PRODUCE,   buildingUid: buid, productTypeId: FOOTMAN, team: 0 },
    ]);
    const ueid = g.spawnUnit(tileCenterFP(1), tileCenterFP(1), 0);
    const uid = UnitId.id[ueid];
    g.applyCommands([{ type: CmdType.MOVE, unitIds: [uid], txFP: tileCenterFP(2), tyFP: tileCenterFP(2) }]);
    g.applyCommands([{ type: CmdType.MOVE, unitIds: [uid], txFP: tileCenterFP(9), tyFP: tileCenterFP(9), queue: true }]);

    const snap = g.takeSnapshot();
    g.world.orders = {}; g.world.production = {}; g.world.rally = {};   // wipe live state
    g.applySnapshot(snap);

    assert.deepEqual(g.world.rally![buid], { txFP: 100, tyFP: 200 }, "rally restored");
    assert.equal(g.world.production![buid].queue[0], FOOTMAN, "production restored");
    assert.equal(g.world.orders![uid].length, 1, "action queue restored");
});

test("despawn clears a building's queue state", () => {
    const g = game12();
    const beid = spawnBuilding(g.world, 4, 4, 0, BARRACKS);
    Building.buildLeft[beid] = 0;
    const buid = UnitId.id[beid];
    g.applyCommands([
        { type: CmdType.PRODUCE,   buildingUid: buid, productTypeId: FOOTMAN, team: 0 },
        { type: CmdType.SET_RALLY, buildingUid: buid, txFP: 1, tyFP: 1, team: 0 },
    ]);
    assert.ok(g.world.production![buid], "queued before despawn");

    g.despawnUnit(beid);
    assert.equal(g.world.production?.[buid], undefined, "production cleared on despawn");
    assert.equal(g.world.rally?.[buid], undefined, "rally cleared on despawn");
});
