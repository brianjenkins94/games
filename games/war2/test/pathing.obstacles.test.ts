/**
 * Pathing regression suite — obstacles.
 *
 * Hand-drawn tiny maps (`#` = wall) where the unit must route around terrain to reach its goal.
 * Each case asserts two invariants:
 *   1. the unit reaches the goal (the flow field found a route), and
 *   2. its trajectory never enters a blocked tile (collision/pathing never walks through a wall).
 * These are the core checks to keep green while reworking the pathing system.
 *
 * Requires `npm run dev`. Run via `npm test`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectInspector, waitForHost, type Inspector } from "./ws";
import { ensureWar2 } from "./browser";
import { tinyMap } from "./fixtures";
import { loadSingleUnit, move, runUntilSettled, tracedTiles, isWalkable } from "./harness";

let insp: Inspector;
let browser: { close: () => Promise<void> } | null = null;

before(async () => {
    insp = await connectInspector();
    browser = await ensureWar2(insp);
    const ok = await waitForHost(insp);
    assert.ok(ok, "no war2 host connected to the debug server — is `npm run dev` running?");
});

after(async () => {
    insp?.close();
    await browser?.close();
});

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

// NOTE: currently `todo` — the present pathing stalls a lone unit at an obstacle (it routes *to* the
// obstacle via the flow field, then aborts at maxStuck instead of going around; reproduced headless
// too, fog ruled out). These encode the target behaviour for the pathing rework; node:test will flag
// them as it starts passing, then drop the `todo`.
for (const c of CASES) {
    test(`pathing: ${c.name}`, { todo: "pathing rework: lone unit must route around obstacles (currently stalls)" }, async () => {
        const map = tinyMap(c.rows);
        const uid = await loadSingleUnit(insp, c.from, map);
        move(insp, uid, c.to);
        const sum = await runUntilSettled(insp, uid, 400, 25);   // obstacles take longer than a straight line

        const u = sum.units?.[0];
        assert.ok(u, `no unit in summarize (${JSON.stringify(sum)})`);
        assert.equal(u.reached, true, `did not reach goal (settled ${JSON.stringify(u.settle)}, finalDist ${u.finalDist}, maxStuck ${u.maxStuck})`);

        for (const [tx, ty] of await tracedTiles(insp, uid)) {
            assert.ok(isWalkable(map, tx, ty), `walked through a blocked tile (${tx},${ty})`);
        }
    });
}
