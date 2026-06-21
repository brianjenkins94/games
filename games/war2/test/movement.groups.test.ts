/**
 * Movement regression suite — multi-unit settling (in-process; no browser).
 *
 * Guards the group-move behaviour the formation-system rework will touch, so it can't silently regress:
 *   • units reach DISTINCT rest tiles (never stack),
 *   • the group SETTLES in bounded time (no endless shuffle/dance), and
 *   • no unit TELEPORTS on settle — a single-tick jump bigger than a step is the "unit zooms into a
 *     space different from where it landed" pop (settleOnto relocating by an instant Position jump).
 * Direct createGame + setFormation/GatherTargets; deterministic, no browser needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../src/game/game";
import { revealAll } from "../src/game/vision";
import { setFormationTargets, setGatherTargets, setMoveTarget } from "../src/game/world";
import { Position, MoveTarget } from "../src/game/components";
import { flowComputeCount } from "../src/game/flowField";

const FP = 1000, TILE = 32;
const tc = (t: number) => t * TILE * FP + (TILE >> 1) * FP;
const tileOf = (e: number) => Math.floor(Position.x[e] / (TILE * FP)) + "," + Math.floor(Position.y[e] / (TILE * FP));
const NO_TELEPORT = 10 * FP;   // a settle must WALK/step, never jump a tile (≥32px) — see settleOnto

type Game = ReturnType<typeof createGame>;

function openGame(n = 15): Game {
    const g = createGame(1, { gids: new Array(n * n).fill(1), mapW: n, mapH: n, terrainArr: [0, 0] });
    revealAll();
    return g;
}

/** Step until every unit settles (or `cap`); return settle tick, distinct rest tiles, and the largest
 *  single-tick displacement of any unit (a teleport shows up here). */
function run(g: Game, eids: number[], cap = 500) {
    let maxJump = 0, settleTick = -1;
    const prev = eids.map(e => [Position.x[e], Position.y[e]]);
    for (let i = 0; i < cap; i++) {
        g.step();
        eids.forEach((e, j) => {
            const d = Math.hypot(Position.x[e] - prev[j][0], Position.y[e] - prev[j][1]);
            if (d > maxJump) maxJump = d;
            prev[j] = [Position.x[e], Position.y[e]];
        });
        if (eids.every(e => !MoveTarget.active[e])) { settleTick = i; break; }
    }
    return { maxJump, settleTick, distinct: new Set(eids.map(tileOf)).size };
}

function assertClean(r: ReturnType<typeof run>, n: number, label: string) {
    assert.ok(r.settleTick >= 0, `${label}: did not settle within cap`);
    assert.equal(r.distinct, n, `${label}: units stacked (${r.distinct}/${n} distinct tiles)`);
    assert.ok(r.maxJump <= NO_TELEPORT, `${label}: a unit TELEPORTED on settle (${(r.maxJump / FP).toFixed(1)}px in one tick)`);
}

test("formation move: distinct tiles, settles, no teleport", () => {
    const g = openGame();
    const E: number[] = []; for (let i = 0; i < 5; i++) E.push(g.spawnUnit(tc(i), tc(0), 0));
    setFormationTargets(g.world, E, tc(7), tc(10));
    assertClean(run(g, E), 5, "formation-5");
});

test("gather/converge: packs into distinct tiles, settles, no teleport", () => {
    const g = openGame();
    const E: number[] = []; for (let i = 0; i < 9; i++) E.push(g.spawnUnit(tc(i % 3), tc((i / 3) | 0), 0));
    setGatherTargets(g.world, E, tc(8), tc(8));
    assertClean(run(g, E), 9, "gather-9");
});

test("arrive at an occupied tile: relocates to a free tile (no stack, no teleport)", () => {
    const g = openGame();
    const b = g.spawnUnit(tc(8), tc(8), 0); for (let i = 0; i < 5; i++) g.step();   // B settles on (8,8)
    const a = g.spawnUnit(tc(8), tc(12), 0);
    setMoveTarget(g.world, a, tc(8), tc(8), true, true);   // single move → avoidUnits aims at a free tile
    assertClean(run(g, [a, b]), 2, "arrive-occupied");
});

test("formation onto an occupied region: slots avoid parked units, no teleport", () => {
    const g = openGame();
    // Bystanders park on the 3×2 block the formation would otherwise claim.
    const B: number[] = [];
    for (let y = 9; y <= 10; y++) for (let x = 6; x <= 8; x++) B.push(g.spawnUnit(tc(x), tc(y), 0));
    for (let i = 0; i < 8; i++) g.step();                       // let bystanders settle
    const settledB = new Set(B.map(tileOf));
    // A separate group moves into the same region.
    const E: number[] = []; for (let i = 0; i < 6; i++) E.push(g.spawnUnit(tc(i), tc(0), 0));
    setFormationTargets(g.world, E, tc(7), tc(10));
    const r = run(g, E);
    assertClean(r, 6, "formation-occupied");
    // Movers must rest on tiles distinct from the parked bystanders (slots avoided them).
    for (const e of E) assert.ok(!settledB.has(tileOf(e)), "formation-occupied: mover settled on a bystander's tile");
});

test("group move shares ONE flow field: one Dijkstra, not one-per-unit", () => {
    const g = openGame();
    const E: number[] = []; for (let i = 0; i < 6; i++) E.push(g.spawnUnit(tc(i), tc(0), 0));
    const before = flowComputeCount();
    setFormationTargets(g.world, E, tc(7), tc(10));   // 6 units, one shared destination
    assert.equal(flowComputeCount() - before, 1, "issuing a 6-unit move computed >1 flow field");
    const afterIssue = flowComputeCount();
    run(g, E);                                        // stepping to settle re-uses the cached field
    assert.equal(flowComputeCount() - afterIssue, 0, "stepping recomputed the shared field");
});

test("formation holds its shape in transit (no clumping on the shared field)", () => {
    const g = openGame(28);
    const E: number[] = []; for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) E.push(g.spawnUnit(tc(2 + x), tc(2 + y), 0));
    const bbox = () => {
        let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
        for (const e of E) { a = Math.min(a, Position.x[e]); b = Math.max(b, Position.x[e]); c = Math.min(c, Position.y[e]); d = Math.max(d, Position.y[e]); }
        return (b - a) * (d - c);
    };
    const startArea = bbox();
    setFormationTargets(g.world, E, tc(24), tc(24));
    let minArea = Infinity;
    for (let i = 0; i < 500; i++) { g.step(); minArea = Math.min(minArea, bbox()); if (E.every(e => !MoveTarget.active[e])) break; }
    // A single shared flow field would let the block CLUMP toward the goal (bbox collapses); the slot
    // decoupling keeps each unit on its own offset, so the block stays cohesive the whole way across.
    assert.ok(minArea >= startArea * 0.75, `formation clumped in transit (bbox ${(minArea / startArea).toFixed(2)}× of start)`);
});

test("formation through a wall gap: threads and settles distinct", () => {
    const rows: string[] = []; for (let y = 0; y < 12; y++) rows.push(y === 6 ? "#####..#####" : "............");
    const gids: number[] = []; for (const r of rows) for (const c of r) gids.push(c === "#" ? 0 : 1);
    const g = createGame(1, { gids, mapW: 12, mapH: 12, terrainArr: [0, 0] }); revealAll();
    const E: number[] = []; for (let i = 0; i < 4; i++) E.push(g.spawnUnit(tc(4 + (i % 2)), tc(9 + ((i / 2) | 0)), 0));
    setFormationTargets(g.world, E, tc(5), tc(2));
    assertClean(run(g, E), 4, "formation-gap");
});
