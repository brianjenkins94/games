/**
 * RenderUnit mapping — guards the host's queue-UI data path.
 *
 * The host renders straight from referee snapshots via renderUnitFromSnapshot (worker/ipc.ts), so the
 * production / rally / action-queue fields MUST be carried through here — otherwise .hud-status has
 * nothing to show on the host (the player).  (The guest fills these from its wire stash instead.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderUnitFromSnapshot } from "../src/worker/ipc";
import type { UnitSnapshot } from "../src/game/types";

const snap = (over: Partial<UnitSnapshot> = {}): UnitSnapshot => ({
    uid: 1, team: 0, type: 5, x: 0, y: 0, mtx: 0, mty: 0, moveActive: 0,
    curTx: 0, curTy: 0, goalTx: 0, goalTy: 0, pathActive: 0, stuckTicks: 0,
    dir: 4, moving: 0, bw: 3, bh: 3, buildLeft: 0, ...over,
});

test("renderUnitFromSnapshot carries production / rally / orders to the render layer", () => {
    const b = renderUnitFromSnapshot(snap({ prod: { queue: [7, 7], ticksLeft: 30, ticksTotal: 60 }, rally: { txFP: 100, tyFP: 200 } }));
    assert.deepEqual(b.prod, { queue: [7, 7], ticksLeft: 30, ticksTotal: 60 }, "production queue reaches RenderUnit");
    assert.deepEqual(b.rally, { txFP: 100, tyFP: 200 }, "rally reaches RenderUnit");

    const u = renderUnitFromSnapshot(snap({ orders: [{ kind: "move", txFP: 1, tyFP: 2 }] }));
    assert.equal(u.orders?.length, 1, "action queue reaches RenderUnit");

    const idle = renderUnitFromSnapshot(snap());
    assert.equal(idle.prod, undefined, "idle unit carries no production");
    assert.equal(idle.rally, undefined, "idle unit carries no rally");
});
