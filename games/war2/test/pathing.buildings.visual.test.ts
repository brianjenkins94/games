/**
 * Building-pathing scenario suite — dual-mode (see harness.ts).
 *
 * Runs IN-PROCESS under CI and against the live host locally (watch the unit route around the building,
 * host at increased game speed); mode is the `CI` env var.  Spawns a real 2×2 building (war2 buildings are
 * 2×2 or 3×3) and sends a unit straight at it; asserts it reaches the far side and detours laterally
 * around the footprint.  The exact octagon collision shape (8px inset + chamfer) stays in
 * pathing.buildings.test.ts, which probes walkGrid directly.
 *
 * Browser mode requires `npm run dev`. Run via `npm test`.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { tinyMap } from "./fixtures";
import { makeDriver, type Driver } from "./harness";

let drv: Driver;
before(async () => { drv = await makeDriver(); });
beforeEach((t) => drv.label(t.name));
after(async () => { await drv.close(); });

const empty = (n: number) => tinyMap(Array.from({ length: n }, () => ".".repeat(n)));

test("unit routes around a 2×2 building blocking its straight path", async () => {
    const FARM = 37, bx = 5, by = 5, fw = 2, fh = 2;   // 2×2 footprint → tiles x:5–6, y:5–6
    // Mover starts above the footprint, in its column, and is sent straight down through it.
    const [uid] = await drv.load([{ tx: 5, ty: 0 }], [{ tx: bx, ty: by, typeId: FARM }], empty(12));

    await drv.move([uid], [5, 11]);
    await drv.settle([uid]);

    const path = await drv.trace(uid);
    assert.ok(path.length > 0, "the mover produced a trace");

    // It got past the building to the far side…
    const final = path[path.length - 1];
    assert.ok(final[1] > by + fh - 1, `mover reached past the building (final tile ${JSON.stringify(final)})`);

    // …by detouring laterally around the footprint (the building blocked its straight column).
    assert.ok(path.some(([tx]) => tx <= bx - 1 || tx >= bx + fw), `mover detoured around the building (path ${JSON.stringify(path)})`);
});
