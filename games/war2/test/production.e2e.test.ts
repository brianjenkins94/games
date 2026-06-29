/**
 * Production + rally — dual-mode e2e via the harness (see harness.ts).
 *
 * A finished barracks trains a queued footman after its build time, then rallies it to a point.  Under
 * CI this runs fully in-process (deterministic, instant).  Locally it drives the LIVE host through the
 * debug-server inspector — exercising the new produce / set_rally / step tools and the prod/rally/type
 * fields on the debug state blob — so you can watch the unit pop out of the barracks and walk to the
 * rally.  Complements the in-process unit-level coverage in queues.test.ts.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { makeDriver, type Driver } from "./harness";
import { emptyMap } from "./fixtures";
import { unitTypeId } from "../src/game/unitTypes";

const BARRACKS = unitTypeId("unit-human-barracks");   // 3×3 building that trains footmen
const FOOTMAN  = unitTypeId("unit-footman");

let drv: Driver;
before(async () => { drv = await makeDriver(); });
beforeEach((t) => drv.label(t.name));
after(async () => { await drv.close(); });

test("a building trains a queued unit and rallies it", async () => {
    await drv.load([], [{ team: 0, tx: 4, ty: 4, typeId: BARRACKS }], emptyMap(12, 12));
    const barracks = (await drv.allUnits()).find(u => u.type === BARRACKS)!;
    assert.ok(barracks, "barracks present after load");

    // Set a rally point, queue a footman, advance one tick.
    await drv.setRally(barracks.uid, [10, 10]);
    await drv.produce(barracks.uid, FOOTMAN);
    await drv.step(1);

    let b = (await drv.allUnits()).find(u => u.uid === barracks.uid)!;
    assert.ok(b.prod && b.prod.queue[0] === FOOTMAN, "PRODUCE enqueued a footman (debug blob shows prod)");
    assert.ok(b.prod.ticksLeft < b.prod.ticksTotal, "production countdown is ticking");
    assert.ok(b.rally, "SET_RALLY recorded (debug blob shows rally)");
    const total = b.prod.ticksTotal;

    // Run to completion → the footman spawns.
    await drv.step(total + 2);
    const footman = (await drv.allUnits()).find(u => u.type === FOOTMAN)!;
    assert.ok(footman, "footman trained and spawned");
    const [x0, y0] = [footman.curTx, footman.curTy];

    // Rally: the trained footman walks toward (10,10).
    await drv.step(20);
    const f2 = (await drv.allUnits()).find(u => u.uid === footman.uid)!;
    assert.ok(f2.curTx > x0 || f2.curTy > y0 || f2.moveActive, "rallied footman is moving toward (10,10)");

    b = (await drv.allUnits()).find(u => u.uid === barracks.uid)!;
    assert.ok(!b.prod, "production queue drained after completion");
});
