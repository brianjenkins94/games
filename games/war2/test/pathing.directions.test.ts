/**
 * Pathing regression suite — directional traversal.
 *
 * On an empty 5x5, a single unit travels from one edge/corner to the opposite, once per compass
 * direction (N/S/E/W + diagonals). Asserts it settles exactly on the goal tile (no short-settling,
 * no corner issues) — the baseline net for the pathing system.
 *
 * Dual-mode via the harness (see harness.ts): in-process under CI, live host locally.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { DIRECTIONS, empty5 } from "./fixtures";
import { makeDriver, type Driver } from "./harness";

let drv: Driver;
before(async () => { drv = await makeDriver(); });
beforeEach((t) => drv.label(t.name));
after(async () => { await drv.close(); });

for (const { dir, from, to } of DIRECTIONS) {
    test(`travels ${dir} across a 5x5  (${from[0]},${from[1]}) → (${to[0]},${to[1]})`, async () => {
        const [uid] = await drv.load([{ tx: from[0], ty: from[1] }], [], empty5());
        await drv.move([uid], to);
        const [u] = await drv.settle([uid]);

        assert.ok(u.curTx === to[0] && u.curTy === to[1],
            `${dir}: settled at (${u.curTx},${u.curTy}), expected (${to[0]},${to[1]})`);
    });
}
