/**
 * Pathing regression suite — diagonal-gap threading.
 *
 * A mover crosses a 5x5 corner-to-corner in each diagonal direction (NE/SE/SW/NW), with two stationary
 * own-team peasants placed at the orthogonal corners of its centre diagonal step. To get through it must
 * thread the diagonal gap BETWEEN them (localPath's diagonal-gap rule — a diagonal move is allowed when
 * both flanking cells are clear of unit C-space). Asserts the mover reaches its goal and doesn't shove
 * the peasants off their tiles.
 *
 * Dual-mode via the harness (see harness.ts): in-process under CI, live host locally.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { DIAGONAL_GAP, empty5 } from "./fixtures";
import { makeDriver, type Driver } from "./harness";

let drv: Driver;
before(async () => { drv = await makeDriver(); });
beforeEach((t) => drv.label(t.name));
after(async () => { await drv.close(); });

for (const { dir, from, to, peasants } of DIAGONAL_GAP) {
    test(`threads a diagonal peasant gap moving ${dir}  (${from[0]},${from[1]}) → (${to[0]},${to[1]})`, async () => {
        // Spawn order: mover first, then the flanking peasants — so ids[0] is the mover.
        const ids = await drv.load(
            [{ tx: from[0], ty: from[1] }, ...peasants.map(([tx, ty]) => ({ tx, ty }))], [], empty5(),
        );
        const moverId = ids[0];
        await drv.move([moverId], to);
        const [m] = await drv.settle([moverId]);

        assert.ok(m.curTx === to[0] && m.curTy === to[1], `${dir}: did not reach goal (settled ${m.curTx},${m.curTy})`);

        // The peasants are obstacles — the mover should have threaded between them, not shoved them away.
        const pe = await drv.state(ids.slice(1));
        peasants.forEach(([tx, ty], i) => {
            assert.ok(pe[i].curTx === tx && pe[i].curTy === ty,
                `${dir}: peasant at (${tx},${ty}) was displaced to (${pe[i].curTx},${pe[i].curTy})`);
        });
    });
}
