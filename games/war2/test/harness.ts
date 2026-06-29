/**
 * Two-mode scenario harness for the e2e suite.
 *
 *   • IN-PROCESS (under CI, i.e. the `CI` env var is set): runs the sim directly via createGame — no
 *     browser, fully deterministic, settles by stepping until every unit is idle.  Instant; no timeouts.
 *   • BROWSER (the local default): drives the live host over the debug-server inspector so you can WATCH
 *     it.  The host runs at its natural 20 TPS but at increased game SPEED; the driver just resumes it
 *     and polls until settled — no manual step-batching, no artificial per-step sleep.
 *
 * Both expose the same interface, so a scenario test reads identically in either mode.  `makeDriver()`
 * picks the mode from the `CI` env var.  Commands go through the real command pipeline
 * (game.applyCommands / the host's command pump), so formation/gather dispatch matches the actual game.
 *
 * IMPORTANT — browser mode drives ONE shared live host, so the suite MUST run serially: parallel test
 * files would each spin up a driver and stomp on each other's scenarios.  `npm test` enforces this with
 * `--test-concurrency=1`; always run the e2e suite that way (don't `node --test` the files in parallel).
 * (In-process/CI mode has no shared state and is parallel-safe, but the flag is harmless there.)
 */
import { connectInspector, waitForHost, sleep, type Inspector } from "./ws";
import { ensureWar2 } from "./browser";
import { tcFP, type MapInfo } from "./fixtures";
import { createGame } from "../src/game/game";
import { revealAll } from "../src/game/vision";
import { Position, MoveTarget, Unit, UnitId, Building, FP, TILE_PX } from "../src/game/components";
import { CmdType } from "../src/net/protocol";

export interface UnitState { uid: number; curTx: number; curTy: number; moveActive: boolean; }
export interface Spawn { team?: number; tx: number; ty: number; typeId?: number; }
export interface BuildingSpawn { team?: number; tx: number; ty: number; typeId: number; }

/** A building's production state (queued product typeIds + head countdown). */
export interface ProdState { queue: number[]; ticksLeft: number; ticksTotal: number; }
/** Full per-unit view for queue/production assertions (a superset of UnitState). */
export interface FullUnit extends UnitState { type: number; team: number; prod?: ProdState; rally?: { txFP: number; tyFP: number }; }

export interface Driver {
    /** True for the browser-attached mode (vs in-process). */
    readonly browser: boolean;
    /** Load a scenario; returns the spawned movers' stable uids in spawn order. */
    load(spawns: Spawn[], buildings: BuildingSpawn[], mapInfo: MapInfo): Promise<number[]>;
    /** Issue a group MOVE (real formation/gather dispatch) toward tile `to`. */
    move(ids: number[], to: [number, number]): Promise<void>;
    /** Advance until every id settles (moveActive=0), then return their final state. Settle-driven.
     *  Browser mode also asserts the live detector auto-flagged NO pathing incident while ticking
     *  (a quiet detector is part of "the scenario pathed cleanly"); pass `expectIncidents` to opt a
     *  deliberately-pathological scenario out of that guard.  In-process mode never runs the detector,
     *  so the guard is a no-op there. */
    settle(ids: number[], expectIncidents?: boolean): Promise<UnitState[]>;
    /** Current state of the given ids. */
    state(ids: number[]): Promise<UnitState[]>;
    /** Tiles a unit's centre passed through since load (oldest→newest). */
    trace(id: number): Promise<[number, number][]>;
    /** Every live unit, with type/team/tile/queue state — for production & action-queue assertions. */
    allUnits(): Promise<FullUnit[]>;
    /** Enqueue a product (PRODUCE) at a building. */
    produce(buildingUid: number, productTypeId: number, team?: number): Promise<void>;
    /** Point a building's freshly trained units at tile `to` (SET_RALLY). */
    setRally(buildingUid: number, to: [number, number], team?: number): Promise<void>;
    /** Advance exactly `n` ticks (deterministic; not settle-driven). Same browser-mode incident guard
     *  as settle() — opt out with `expectIncidents`. */
    step(n: number, expectIncidents?: boolean): Promise<void>;
    /** Show a label (e.g. the running test name) in the host's upper-left badge.  No-op in-process. */
    label(name: string): void;
    close(): Promise<void>;
}

/** Pick the driver from the environment: headless/in-process under CI (`CI` set), else drive the live
 *  host so you can watch it locally (needs `npm run dev`). */
export async function makeDriver(): Promise<Driver> {
    if (process.env.CI) return inProcessDriver();
    const insp = await connectInspector();
    const browser = await ensureWar2(insp);
    if (!(await waitForHost(insp))) throw new Error("no war2 host on the debug server — is `npm run dev` running?");
    return browserDriver(insp, browser);
}

const tileOf = (fp: number) => Math.floor(fp / (TILE_PX * FP));

// ── In-process (CI / headless) ───────────────────────────────────────────────

function inProcessDriver(): Driver {
    let game: ReturnType<typeof createGame>;
    let tracked: number[] = [];
    const traces = new Map<number, [number, number][]>();
    const eidOf  = (uid: number) => game.eidForUnitId(uid)!;
    const stateOf = (uid: number): UnitState => {
        const e = eidOf(uid);
        return { uid, curTx: tileOf(Position.x[e]), curTy: tileOf(Position.y[e]), moveActive: MoveTarget.active[e] === 1 };
    };
    const record = () => {
        for (const uid of tracked) {
            const s = stateOf(uid), tr = traces.get(uid)!, last = tr[tr.length - 1];
            if (!last || last[0] !== s.curTx || last[1] !== s.curTy) tr.push([s.curTx, s.curTy]);
        }
    };
    return {
        browser: false,
        async load(spawns, buildings, mapInfo) {
            game = createGame(1, mapInfo);
            revealAll();
            game.initUnitIdCounter(0);
            const ids = spawns.map(s => UnitId.id[game.spawnUnit(tcFP(s.tx), tcFP(s.ty), s.team ?? 0, undefined, s.typeId ?? 0)]);
            for (const b of buildings) {
                const beid = game.spawnBuilding(b.tx, b.ty, b.team ?? 0, b.typeId);
                Building.buildLeft[beid] = 0;   // scenarios place finished buildings (match the host path)
            }
            tracked = ids;
            traces.clear();
            for (const id of ids) traces.set(id, [[stateOf(id).curTx, stateOf(id).curTy]]);
            return ids;
        },
        async move(ids, to) {
            game.applyCommands([{ type: CmdType.MOVE, unitIds: ids, txFP: tcFP(to[0]), tyFP: tcFP(to[1]) }]);
        },
        async settle(ids, _expectIncidents) {
            // Settle-driven: step until idle (generous safety cap — deterministic, never hit normally).
            // The pathology detector lives in referee.worker, not the sim, so there's nothing to guard here.
            for (let i = 0; i < 5000 && ids.some(id => stateOf(id).moveActive); i++) { game.step(); record(); }
            return ids.map(stateOf);
        },
        async state(ids) { return ids.map(stateOf); },
        async trace(id)  { return traces.get(id) ?? []; },
        async allUnits() {
            return game.unitEids().map(e => {
                const uid = UnitId.id[e];
                return {
                    uid, type: Unit.type[e], team: Unit.team[e],
                    curTx: tileOf(Position.x[e]), curTy: tileOf(Position.y[e]),
                    moveActive: MoveTarget.active[e] === 1,
                    prod: game.world.production?.[uid], rally: game.world.rally?.[uid],
                };
            });
        },
        async produce(buildingUid, productTypeId, team = 0) {
            game.applyCommands([{ type: CmdType.PRODUCE, buildingUid, productTypeId, team }]);
        },
        async setRally(buildingUid, to, team = 0) {
            game.applyCommands([{ type: CmdType.SET_RALLY, buildingUid, txFP: tcFP(to[0]), tyFP: tcFP(to[1]), team }]);
        },
        async step(n, _expectIncidents) { for (let i = 0; i < n; i++) { game.step(); record(); } },
        label()          { /* headless — no host badge */ },
        async close()    { /* nothing to tear down */ },
    };
}

// ── Browser (watchable; drives the live host) ────────────────────────────────

function browserDriver(insp: Inspector, browser: { close: () => Promise<void> } | null): Driver {
    const SPEED = 4;   // run the host fast (20 TPS × 4) while still rendering — see referee MAX_SPEED
    const fetch = async (ids: number[]): Promise<UnitState[]> => {
        const units: any[] = (await insp.query("state")).host?.units ?? [];
        return ids.map(id => {
            const u = units.find(x => x.uid === id);
            return { uid: id, curTx: u?.curTx ?? -1, curTy: u?.curTy ?? -1, moveActive: !!u?.moveActive };
        });
    };

    // ── Incident guard ────────────────────────────────────────────────────────
    // The live referee's read-only detector auto-flags pathing incidents (stuck/give-up/settled-short/
    // oscillating) onto the debug server as the host ticks.  `markIncidents()` records the high-water id
    // at scenario load; `assertQuiet()` (run at the end of every host-ticking step) fails the *current*
    // test — with the offending label — if any NEW incident appeared, so a quiet detector is asserted, not
    // just spot-checked.  Incident ids are `inc_<n>` (monotonic).
    const seqOf = (id: string): number => Number(id.split("_")[1]) || 0;
    const incidentsNow = async (): Promise<{ id: string; label: string }[]> =>
        (await insp.query("incidents")).incidents ?? [];
    let incidentMark = -1;   // high-water incident seq at the current scenario's load
    const markIncidents = async () => {
        incidentMark = (await incidentsNow()).reduce((m, i) => Math.max(m, seqOf(i.id)), -1);
    };
    const assertQuiet = async (expectIncidents?: boolean) => {
        if (expectIncidents) return;
        const fresh = (await incidentsNow()).filter(i => seqOf(i.id) > incidentMark);
        if (fresh.length) {
            await markIncidents();   // don't re-report the same incident on a later guard in this test
            throw new Error(
                `pathing incident(s) auto-flagged during the run: ${fresh.map(i => i.label || i.id).join("; ")}` +
                ` — replay_incident <id> to investigate, or settle/step(…, expectIncidents=true) if intended`);
        }
    };
    return {
        browser: true,
        async load(spawns, buildings, mapInfo) {
            // Load PAUSED (loadScenario pauses the sim) and stay paused through move() — so the units take
            // no idle ticks before the order, matching the in-process driver (issue-then-run).
            insp.ctrl({ cmd: "load-scenario", scenario: {
                mapInfo,
                spawns:    spawns.map(s => ({ team: s.team ?? 0, tx: s.tx, ty: s.ty, typeId: s.typeId })),
                buildings: buildings.map(b => ({ team: b.team ?? 0, tx: b.tx, ty: b.ty, typeId: b.typeId })),
            } });
            // Units spawn synchronously on load (no ticks needed); poll until the host has applied it.
            let units: any[] = [];
            for (let i = 0; i < 60; i++) {
                await sleep(100);
                units = (await insp.query("state")).host?.units ?? [];
                if (spawns.every(s => units.some(u => u.curTx === s.tx && u.curTy === s.ty))) break;
            }
            await markIncidents();   // baseline so the guard only counts incidents from THIS scenario
            return spawns
                .map(s => units.find(u => u.curTx === s.tx && u.curTy === s.ty)?.uid)
                .filter((u): u is number => u != null);
        },
        async move(ids, to) {
            // Queued while paused; applies on the first tick of the next settle() (no idle ticks first).
            insp.ctrl({ cmd: "command", command: { type: CmdType.MOVE, unitIds: ids, txFP: tcFP(to[0]), tyFP: tcFP(to[1]) } });
        },
        async settle(ids, expectIncidents) {
            // Run the host at speed (20 TPS × SPEED) until settled, then pause again.  Poll-driven, not a
            // per-step sleep cap; the loop bound is just a safety net.
            insp.ctrl({ cmd: "command", command: { type: CmdType.SPEED, speed: SPEED } });
            insp.ctrl({ cmd: "resume" });
            for (let i = 0; i < 300; i++) {
                await sleep(100);
                const s = await fetch(ids);
                if (s.length === ids.length && s.every(u => !u.moveActive)) break;
            }
            await sleep(500);   // let the renderer visibly glide into place
            insp.ctrl({ cmd: "pause" });
            await assertQuiet(expectIncidents);   // the detector stayed silent over this settle
            return fetch(ids);
        },
        state: (ids) => fetch(ids),
        async trace(id) {
            const tr = await insp.query("trace", { uid: id, from: 0 });
            return (tr.units?.[id] ?? []).map((s: { tx: number; ty: number }) => [s.tx, s.ty] as [number, number]);
        },
        async allUnits() {
            const units: any[] = (await insp.query("state")).host?.units ?? [];
            return units.map(u => ({
                uid: u.uid, type: u.type, team: u.team,
                curTx: u.curTx ?? -1, curTy: u.curTy ?? -1, moveActive: !!u.moveActive,
                prod: u.prod, rally: u.rally,
            }));
        },
        async produce(buildingUid, productTypeId, team = 0) {
            insp.ctrl({ cmd: "command", command: { type: CmdType.PRODUCE, buildingUid, productTypeId, team } });
        },
        async setRally(buildingUid, to, team = 0) {
            insp.ctrl({ cmd: "command", command: { type: CmdType.SET_RALLY, buildingUid, txFP: tcFP(to[0]), tyFP: tcFP(to[1]), team } });
        },
        async step(n, expectIncidents) {
            // The host is paused after load(); buffered commands apply on the first stepped tick.  Poll the
            // server's latest tick until it advances by n (not a fixed sleep), then let the blob settle.
            const tickNow = async () => (await insp.query("state")).tick ?? 0;
            const target = (await tickNow()) + n;
            insp.ctrl({ cmd: "step", n });
            for (let i = 0; i < 100; i++) { await sleep(50); if ((await tickNow()) >= target) break; }
            await sleep(150);
            await assertQuiet(expectIncidents);   // the detector stayed silent over these ticks
        },
        label(name) { insp.ctrl({ cmd: "set-label", text: name }); },
        async close() { insp.close(); await browser?.close(); },
    };
}
