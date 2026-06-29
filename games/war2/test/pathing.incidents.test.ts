/**
 * Pathing-incident regression suite (in-process / CI).
 *
 * Each fixture in test/incidents/*.json is a captured pathing incident — map + a full deterministic
 * snapshot + the command log + a focus unit/goal — promoted from the live game via the inspector's
 * `save_incident_test` tool (see tools/debug-server.mjs).  This runner rebuilds the sim on the incident's
 * map, restores the snapshot, replays the captured commands AT THEIR TICKS to the flag tick, asserts the
 * replay reproduced the captured state exactly (the `expectHash` self-check — proves the repro is
 * faithful), then steps to settle and asserts the outcome (default: the focus unit reaches its goal).
 * Determinism makes the replay exact, so a fixed pathing bug stays fixed.  Drop a fixture's JSON to retire it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasComponent } from "bitecs";
import { createGame } from "../src/game/game";
import { Position, Path, MoveTarget, Building, FP, TILE_PX } from "../src/game/components";

const DIR = fileURLToPath(new URL("./incidents/", import.meta.url));
const files = existsSync(DIR) ? readdirSync(DIR).filter(f => f.endsWith(".json")) : [];
const tileOf = (fp: number) => Math.floor(fp / (TILE_PX * FP));

interface Fixture {
    id: string; label?: string; baseTick?: number; flagTick?: number; expectHash?: number;
    map: { gids: number[]; mapW: number; mapH: number; terrainArr: number[] };
    snapshot: any;
    commands?: { tick: number; commands: any[] }[];
    focus?: { uid: number; goal: [number, number] };
    expect?: { reachesGoal?: boolean; maxStuck?: number; noOverlap?: boolean; settleBudget?: number };
}

for (const file of files) {
    const fx: Fixture = JSON.parse(readFileSync(DIR + file, "utf8"));
    test(`incident ${fx.id}: ${fx.label || file}`, () => {
        const g = createGame(1, fx.map);
        g.applySnapshot(fx.snapshot);   // restore the exact captured state (at baseTick) onto the incident's map

        const focusEid = () => (fx.focus ? g.eidForUnitId(fx.focus.uid) : undefined);
        const focusMoving = () => { const e = focusEid(); return e !== undefined && MoveTarget.active[e] === 1; };

        // Replay captured commands tick-accurately to flagTick.  A command logged at post-step tick T was
        // applied during the tick that produced T (when world.tick was T-1); commands at/before baseTick
        // are already baked into the snapshot.
        const cmds = (fx.commands ?? []).filter(c => c.tick > (fx.baseTick ?? 0)).sort((a, b) => a.tick - b.tick);
        let ci = 0;
        while (fx.flagTick != null && g.world.tick < fx.flagTick) {
            while (ci < cmds.length && cmds[ci].tick - 1 === g.world.tick) g.applyCommands(cmds[ci++].commands);
            g.step();
        }

        // Determinism self-check: the replay must reproduce the captured state before we judge the outcome.
        if (fx.expectHash != null) assert.equal(g.hashOwn(0), fx.expectHash, "replay reproduced the captured state exactly");

        // Run to settle, then assert the outcome.
        const budget = fx.expect?.settleBudget ?? 600;
        for (let i = 0; i < budget && focusMoving(); i++) g.step();

        if (fx.focus && fx.expect?.reachesGoal) {
            const e = focusEid();
            assert.ok(e !== undefined, "focus unit still present after replay");
            const tx = tileOf(Position.x[e]), ty = tileOf(Position.y[e]);
            const [gx, gy] = fx.focus.goal;
            assert.ok(Math.abs(tx - gx) + Math.abs(ty - gy) <= 1, `focus unit reached its goal (settled ${tx},${ty}; goal ${gx},${gy})`);
        }
        if (fx.focus && fx.expect?.maxStuck != null) {
            const e = focusEid();
            assert.ok(e !== undefined && Path.stuckTicks[e] <= fx.expect.maxStuck, `focus stuckTicks ≤ ${fx.expect.maxStuck} (was ${e !== undefined ? Path.stuckTicks[e] : "gone"})`);
        }
        if (fx.expect?.noOverlap) {
            const seen = new Set<number>();
            for (const e of g.unitEids()) {
                if (hasComponent(g.world, e, Building)) continue;
                const k = tileOf(Position.y[e]) * 4096 + tileOf(Position.x[e]);
                assert.ok(!seen.has(k), `two units share tile ${tileOf(Position.x[e])},${tileOf(Position.y[e])}`);
                seen.add(k);
            }
        }
    });
}
