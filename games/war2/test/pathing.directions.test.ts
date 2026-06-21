/**
 * Pathing regression suite — directional traversal.
 *
 * On an empty 5x5, a single unit travels from one edge/corner to the opposite, once per compass
 * direction (N/S/E/W + diagonals). Asserts it actually reaches the goal tile (no short-settling,
 * no corner issues). This is the baseline net before reworking the pathing system — extend with
 * obstacle maps using `tinyMap`.
 *
 * Requires `npm run dev` running (debug server on :9229). If no war2 host is already connected,
 * the suite opens one via Playwright (attach to CDP, else launch). Run: `npm test`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectInspector, waitForHost, type Inspector } from "./ws";
import { ensureWar2 } from "./browser";
import { DIRECTIONS } from "./fixtures";
import { loadSingleUnit, move, runUntilSettled } from "./harness";

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

for (const { dir, from, to } of DIRECTIONS) {
    test(`travels ${dir} across a 5x5  (${from[0]},${from[1]}) → (${to[0]},${to[1]})`, async () => {
        const uid = await loadSingleUnit(insp, from);
        move(insp, uid, to);
        const sum = await runUntilSettled(insp, uid);

        const u = sum.units?.[0];
        assert.ok(u, `${dir}: no unit in summarize (${JSON.stringify(sum)})`);
        assert.deepEqual(u.settle, to, `${dir}: settled at ${JSON.stringify(u.settle)}, expected ${JSON.stringify(to)} (finalDist ${u.finalDist}, maxStuck ${u.maxStuck})`);
        assert.equal(u.reached, true, `${dir}: did not reach goal`);
    });
}
