/**
 * Pathing regression suite — diagonal-gap threading.
 *
 * A mover crosses a 7x7 corner-to-corner in each diagonal direction (NE/SE/SW/NW), with two stationary
 * own-team peasants placed at the orthogonal corners of its centre diagonal step. To get through it must
 * thread the diagonal gap BETWEEN them (localPath's diagonal-gap rule — a diagonal move is allowed when
 * both flanking cells are clear of unit C-space). Asserts the mover reaches its goal and doesn't shove
 * the peasants off their tiles.
 *
 * Requires `npm run dev`. Run via `npm test`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectInspector, waitForHost, type Inspector } from "./ws";
import { ensureWar2 } from "./browser";
import { DIAGONAL_GAP } from "./fixtures";
import { loadMoverWithObstacles, move, runUntilSettled } from "./harness";

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

for (const { dir, from, to, peasants } of DIAGONAL_GAP) {
    test(`threads a diagonal peasant gap moving ${dir}  (${from[0]},${from[1]}) → (${to[0]},${to[1]})`, async () => {
        const uid = await loadMoverWithObstacles(insp, from, peasants);
        move(insp, uid, to);
        const sum = await runUntilSettled(insp, uid);

        const u = sum.units?.[0];
        assert.ok(u, `${dir}: no unit in summarize (${JSON.stringify(sum)})`);
        assert.equal(u.reached, true, `${dir}: did not reach goal (settled ${JSON.stringify(u.settle)}, finalDist ${u.finalDist}, maxStuck ${u.maxStuck})`);

        // The peasants are obstacles — the mover should have threaded between them, not shoved them away.
        const units = (await insp.query("state")).host?.units ?? [];
        for (const [tx, ty] of peasants) {
            const here = units.some((p: { curTx: number; curTy: number }) => p.curTx === tx && p.curTy === ty);
            assert.ok(here, `${dir}: peasant at (${tx},${ty}) was displaced`);
        }
    });
}
