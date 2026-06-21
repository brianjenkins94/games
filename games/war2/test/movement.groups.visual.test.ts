/**
 * Group-movement scenario suite — dual-mode (see harness.ts).
 *
 * Runs IN-PROCESS under CI (deterministic, instant) and against the live host locally (so you can watch
 * the block travel and fan into place — the host runs at increased game speed); mode is the `CI` env var.
 * Either way it drives the real formation/gather pipeline (game.applyCommands).  Assertions are smoke-level:
 * every unit reaches, settles, and lands on a distinct tile.  The precise invariants (no settle-teleport,
 * one shared Dijkstra) stay in movement.groups.test.ts, which probes internals the host can't expose.
 *
 * Browser mode requires `npm run dev`. Run via `npm test`.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tinyMap } from "./fixtures";
import { makeDriver, type Driver, type Spawn } from "./harness";

let drv: Driver;
before(async () => { drv = await makeDriver(); });
beforeEach((t) => drv.label(t.name));
after(async () => { await drv.close(); });

const empty = (n: number) => tinyMap(Array.from({ length: n }, () => ".".repeat(n)));
const block = (tiles: [number, number][]): Spawn[] => tiles.map(([tx, ty]) => ({ tx, ty }));
const distinctTiles = (units: { curTx: number; curTy: number }[]) => new Set(units.map(u => `${u.curTx},${u.curTy}`)).size;

test("formation move: a 3×2 block travels and settles on distinct tiles", async () => {
    const ids = await drv.load(block([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]), [], empty(14));
    assert.equal(ids.length, 6, "all six spawned");

    await drv.move(ids, [9, 11]);
    const units = await drv.settle(ids);

    assert.ok(units.every(u => !u.moveActive), "all settled");
    assert.equal(distinctTiles(units), 6, "settled on distinct tiles (no stacking)");
});

test("gather/converge: a re-click packs nine units into a tidy block", async () => {
    const spread: [number, number][] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) spread.push([x * 2, y * 2]);   // 3×3 spread
    const ids = await drv.load(block(spread), [], empty(16));
    assert.equal(ids.length, 9, "all nine spawned");

    // Same selection + tile twice → the second MOVE is a converge (gather) — see systems/commands.ts.
    await drv.move(ids, [11, 11]); await drv.settle(ids);
    await drv.move(ids, [11, 11]);
    const units = await drv.settle(ids);

    assert.ok(units.every(u => !u.moveActive), "all settled");
    assert.equal(distinctTiles(units), 9, "packed into distinct tiles");
});

test("formation through a wall gap: the block threads a 2-wide gap and settles distinct", async () => {
    const rows = Array.from({ length: 12 }, (_, y) => (y === 6 ? "#####..#####" : "............"));
    const ids = await drv.load(block([[4, 9], [5, 9], [4, 10], [5, 10]]), [], tinyMap(rows));
    assert.equal(ids.length, 4, "all four spawned");

    await drv.move(ids, [5, 2]);   // destination across the wall → must thread the gap
    const units = await drv.settle(ids);

    assert.ok(units.every(u => !u.moveActive), "all settled");
    assert.equal(distinctTiles(units), 4, "settled on distinct tiles past the wall");
    assert.ok(units.every(u => u.curTy < 6), "all threaded to the far side of the wall");
});
