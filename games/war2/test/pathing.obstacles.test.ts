/**
 * Pathing regression suite — obstacles.
 *
 * Hand-drawn tiny maps (`#` = wall) where the unit must route around terrain to reach its goal.
 * Each case asserts two invariants:
 *   1. the unit reaches the goal (the flow field found a route), and
 *   2. its trajectory never enters a blocked tile (collision/pathing never walks through a wall).
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

interface Case { name: string; rows: string[]; from: [number, number]; to: [number, number]; }

const CASES: Case[] = [
    {
        name: "detours through the gap in a wall",
        rows: [".......", ".......", ".......", "######.", ".......", ".......", "......."],
        from: [0, 0], to: [0, 6],   // wall across row 3, only opening at col 6 → must detour right
    },
    {
        name: "routes around a central block",
        rows: [".......", ".......", "..###..", "..###..", "..###..", ".......", "......."],
        from: [0, 3], to: [6, 3],   // 3x3 block dead centre → go over or under
    },
    {
        name: "rounds a tight 2x2 block",
        rows: ["....", ".##.", ".##.", "...."],
        from: [0, 0], to: [3, 3],   // diagonal goal past a 2x2 block → no corner-cut into the block
    },
];

for (const c of CASES) {
    test(`pathing: ${c.name}`, async () => {
        const map = tinyMap(c.rows);
        const [uid] = await drv.load([{ tx: c.from[0], ty: c.from[1] }], [], map);
        await drv.move([uid], c.to);
        const [u] = await drv.settle([uid]);

        assert.ok(u.curTx === c.to[0] && u.curTy === c.to[1], `did not reach goal (settled ${u.curTx},${u.curTy})`);
        for (const [tx, ty] of await drv.trace(uid)) {
            assert.ok(isWalkable(map, tx, ty), `walked through a blocked tile (${tx},${ty})`);
        }
    });
}
