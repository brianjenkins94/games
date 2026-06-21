/**
 * Pathing regression suite — diagonal terrain threading.
 *
 * Walls collide as DIAMONDS (walkGrid.terrainClearAt), so a unit threads a diagonal wall pinch the same
 * way it threads between two diagonally-placed units — the diamonds touch but never overlap, and the
 * unit's centre never enters a wall.  Each case asserts the unit reaches the goal and never walks its
 * centre through a blocked tile.
 *
 * Dual-mode via the harness (see harness.ts): in-process under CI, live host locally.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tinyMap, isWalkable } from "./fixtures";
import { makeDriver, type Driver } from "./harness";

let drv: Driver;
before(async () => { drv = await makeDriver(); });
beforeEach((t) => drv.label(t.name));
after(async () => { await drv.close(); });

interface Case { name: string; rows: string[]; from: [number, number]; to: [number, number]; todo?: string; }

const CASES: Case[] = [
    {
        // A single-width wall along the main diagonal: the only crossings are the diagonal pinches
        // between consecutive wall tiles.  The mover travels parallel to the wall, threading each pinch.
        name: "threads a single-width diagonal wall (NW↘SE)",
        rows: ["#.....", ".#....", "..#...", "...#..", "....#.", ".....#"],
        from: [5, 0], to: [0, 5],
    },
    {
        // Same wall, crossed in the opposite direction.
        name: "threads a single-width diagonal wall (SE↖NW)",
        rows: ["#.....", ".#....", "..#...", "...#..", "....#.", ".....#"],
        from: [0, 5], to: [5, 0],
    },
    {
        // A 1-wide ANTI-diagonal wall, crossed by threading consecutive diagonal pinches entered
        // perpendicular from a cardinal lane.  The footprint A* can't plan this (the inflated corridor is
        // measure-zero), so movement.ts handles it reactively: when the flow steers into a pinch (both
        // flanks walls) the unit COMMITS to a corridor waypoint at the exit tile centre and drives there
        // centre-to-centre — projecting onto the corridor segment first — without re-sampling the flow.
        name: "crosses a 1-wide anti-diagonal wall",
        rows: ["..#", ".#.", "#.."],
        from: [2, 2], to: [0, 0],
    },
    {
        // The mirror orientation — its pinch midpoint is the exact 4-tile corner that used to wedge it.
        name: "crosses a 1-wide anti-diagonal wall (mirrored)",
        rows: ["#..", ".#.", "..#"],
        from: [2, 0], to: [0, 2],
    },
];

for (const c of CASES) {
    test(`pathing: ${c.name}`, c.todo ? { todo: c.todo } : {}, async () => {
        const map = tinyMap(c.rows);
        const [uid] = await drv.load([{ tx: c.from[0], ty: c.from[1] }], [], map);
        await drv.move([uid], c.to);
        const [u] = await drv.settle([uid]);

        assert.ok(u.curTx === c.to[0] && u.curTy === c.to[1], `did not reach goal (settled ${u.curTx},${u.curTy})`);
        for (const [tx, ty] of await drv.trace(uid)) {
            assert.ok(isWalkable(map, tx, ty), `walked its centre through a blocked tile (${tx},${ty})`);
        }
    });
}
