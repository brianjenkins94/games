/**
 * Referee worker (host only) — the single authoritative simulation.
 *
 * Runs the deterministic sim of BOTH teams, applies each client's validated
 * commands, and sends every client only its own *fog view* (own units + enemies
 * currently in its sight).  Because the referee holds all positions it can do the
 * per-recipient visibility filtering that a P2P peer never could — so unseen enemy
 * state never crosses the wire (genuine fog), and because it is the sole creator /
 * mover of units, a client cannot fabricate units, teleport, or cheat the economy.
 *
 * Clients reach the referee through net/transport.ts: the host plays in-process
 * (LocalRefereeClient over postMessage); the guest is a RemoteRefereeClient over
 * the data channel.  Lifting this to a neutral server makes the host remote too,
 * with no change here.
 *
 * Runs in a Worker so it keeps simulating when the host's tab is backgrounded.
 */
import { createGame, type GameInstance, type MapInfo, type WorldSnapshot } from "../game/game";
import { validateCommand } from "../game/validate";
import { hasComponent } from "bitecs";
import { UnitId, MoveTarget, Path, Unit, TICK_MS, tileCenterFP, fpToTile, Building } from "../game/components";
import { CmdType, type Command, type UnitSnapshot, type StateUpdatePayload } from "../net/protocol";
import { LocalRefereeClient, RemoteRefereeClient, type RefereeClient } from "../net/transport";
import { getPassability } from "../game/passability";
import { revealAll } from "../game/vision";
import { initDebugClient, sendDebugState, sendDebugCommands, sendIncident, sendDiagError, wireBoxConsole, setDebugCallbacks, type DebugScenario } from "../debug/client";
import {
    renderUnitFromSnapshot,
    type MainToWorker, type WorkerToMain, type RenderState, type MetricsSample, type WorkerInit, type SimDebugState, type SimDebugUnit,
} from "./ipc";

const post = (msg: WorkerToMain, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);

// Wire this box's console (worker → overlay + server) and get the relay for its main-thread console.
const relayClientConsole = wireBoxConsole(post);

// ── Runtime state ─────────────────────────────────────────────────────────────

let game!: GameInstance;
let myTeam   = 0;          // the host's team
let oppTeam  = 1;          // the guest's team
let mapW = 0, mapH = 0;
let seed = 0;              // remembered from init; reused by debug loadScenario when none is given
let simPaused = false;
let stepping  = false;   // step debugger: forces a single tick through the simPaused gate
let started   = false;

// Step-debugger breakpoints (see checkBreakpoints, evaluated each tick while running).
type BpFn = (tick: number, units: SimDebugUnit[], hash: number, paused: boolean, count: number, team: (t: number) => number, unit: (uid: number) => SimDebugUnit | undefined) => unknown;
let bpFns: { src: string; fn: BpFn }[] = [];   // conditional/expression breakpoints (fire on rising edge)
let bpPrev: boolean[] = [];                     // last truth value per expr (for edge detection)
let dataBps: string[] = [];                     // data breakpoints — dataIds watched for change
let dataPrev = new Map<string, number>();       // last observed value per watched dataId

// Reverse debugging: a ring of per-tick snapshots recorded while a debug session is attached. The
// sim is deterministic, so a full snapshot per tick is enough to rewind — no command replay needed.
let historyEnabled = false;
const HISTORY_MAX = 2400;                        // ~2 min at 20 TPS; oldest snapshots drop off
const history: { tick: number; snap: WorldSnapshot }[] = [];

// Pathing-incident capture (dev only): a small always-on snapshot ring so a flag captures the LEAD-UP
// to a pathology, not just the moment it's noticed.  The current map is kept so an incident is a
// self-contained, replayable repro (deterministic sim → exact reproduction).
let currentMap: MapInfo | null = null;
const INCIDENT_SNAP_EVERY = 30;                  // snapshot ~every 1.5 s
const INCIDENT_RING_MAX = 6;                     // keep ~9 s of lead-up
const incidentRing: { tick: number; snap: WorldSnapshot }[] = [];

// Pathing-pathology auto-detector (dev only): a read-only post-step scan of unit state. Surfaces a
// live count to the HUD and auto-flags sustained episodes as incidents (debounced + per-signature dedup).
const STUCK_FLAG = 24;                            // grinding ~2/3 toward the settle limit (36)
const AUTOFLAG_COOLDOWN = 100;                    // ≥5 s between ANY auto-captures
const AUTOFLAG_SUSTAIN = 20;                      // a stuck unit must persist this long before auto-flag
const AUTOFLAG_DEDUP = 600;                       // don't re-flag the SAME unit+kind within ~30 s
const OSC_WINDOW = 6;                             // distinct-consecutive tiles to look back over for bouncing
interface PathoTrack { prevMove: number; prevSlotTx: number; prevSlotTy: number; tiles: number[]; stuckSince: number }
const pathoTracks = new Map<number, PathoTrack>();   // uid → per-unit tracking
const autoFlagged = new Map<string, number>();   // "<kind>:<uid>" → tick last auto-flagged (dedup)
let pathoCount = -1;                              // last count posted to the HUD (−1 = force first post)
let lastAutoFlag = -1e9;                          // tick of the last auto-flag (debounce)

// ── Game speed (authoritative) ──────────────────────────────────────────────────
// A positive multiplier on the wall-clock tick cadence — NOT the logical timestep. Each tick
// still advances the sim by the same fixed amount, so the tick sequence/results are identical at
// any speed (determinism, client reconciliation, and world hashing are unaffected); only how fast
// ticks fire in real time changes. Requested via CmdType.SPEED, clamped here, broadcast in every
// snapshot so clients match. Pause is the separate `simPaused` gate (a stopped loop couldn't
// process the resume command, so speed deliberately stays > 0).
const MIN_SPEED = 0.25, MAX_SPEED = 4;
let speed = 1;
let tickTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleTick(): void {
    if (tickTimer !== undefined) clearTimeout(tickTimer);
    // try/finally so a throw in tick() (e.g. a dev-only diagnostic) can never kill the self-rescheduling
    // loop and freeze the host permanently.
    tickTimer = setTimeout(() => { tickTimer = undefined; try { tick(); } finally { scheduleTick(); } }, TICK_MS / speed);
}

function setSpeed(s: number): void {
    const next = Math.max(MIN_SPEED, Math.min(MAX_SPEED, s));
    if (next === speed) return;
    speed = next;
    if (started) scheduleTick();   // re-arm at the new interval (scheduleTick clears the old timer)
}

// Perf probes (flushed to the host page ~4 Hz, off the render hot path).  The host is
// in-process so it has no wire RTT/lead — only tick cost, entity count, and the bytes
// it pushes to / receives from the remote guest are meaningful here.
const METRICS_MS = 250;
const SNAPSHOT_MS = 2000;   // host-state heartbeat → host page → restore on a host-box reboot
let tickMs   = 0;   // duration of the most recent sim step
let bytesIn  = 0;   // from the guest channel, accumulated since the last flush
let bytesOut = 0;   // to the guest channel, accumulated since the last flush

// ── Clients ───────────────────────────────────────────────────────────────────
// The host's in-process client is always present; the guest joins when its channel
// arrives.  Each client's commands accumulate in a buffer drained every tick.

let hostClient!: LocalRefereeClient;
let guestClient: RemoteRefereeClient | null = null;
const pending = new Map<RefereeClient, Command[]>();
const lastPing = new Map<RefereeClient, number>();

/** Stamp create-commands with the issuing client's team (the authoritative source). */
function stampTeam(cmd: Command, team: number): Command {
    if (cmd.type === CmdType.SPAWN || cmd.type === CmdType.BUILD) return { ...cmd, team };
    return cmd;
}

function registerClient(c: RefereeClient): void {
    pending.set(c, []);
    c.onCommand = (cmds, pingTs) => {
        const buf = pending.get(c)!;
        for (const cmd of cmds) buf.push(stampTeam(cmd, c.team));
        if (pingTs) lastPing.set(c, pingTs);
    };
}

function clients(): RefereeClient[] {
    return guestClient ? [hostClient, guestClient] : [hostClient];
}

/** Units visible to `team`: its own units + enemy units currently in its sight. */
function fogSnapshot(team: number): UnitSnapshot[] {
    const visible = game.computeVisibleUids(team);
    const out: UnitSnapshot[] = [];
    for (const eid of game.unitEids()) {
        if (visible.has(UnitId.id[eid])) out.push(game.snapshotUnit(eid));
    }
    return out;
}

function toRenderState(payload: StateUpdatePayload): RenderState {
    return { tick: payload.tick, units: payload.visibleStates.map(renderUnitFromSnapshot) };
}

function emitMetrics(): void {
    let units = 0;
    for (const _ of game.unitEids()) units++;
    const sample: MetricsSample = { tickMs, rtt: 0, lead: 0, units, bytesIn, bytesOut };
    bytesIn = bytesOut = 0;
    post({ kind: "metrics", sample });
}

/** Heartbeat the authoritative state to the host page so it can restore the game into a host box that
 *  reloads (popped out into its own tab, re-attached, or recycled). Up to SNAPSHOT_MS of rewind. */
function emitSnapshot(): void {
    if (started) post({ kind: "snapshot", snap: game.takeSnapshot() });
}

// ── Networking (guest channel: transferred, else relayed through host main) ──────

let channel: RTCDataChannel | null = null;

function attachGuestChannel(ch: RTCDataChannel): void {
    // Reconnect (the guest box popped out + reloaded): drop the stale guest so we don't accumulate
    // dead clients in `pending`/`lastPing`. The referee keeps running; the fresh guest resyncs from
    // the next snapshots. See games/war2/docs/box-reconnection.md.
    if (guestClient) { pending.delete(guestClient); lastPing.delete(guestClient); guestClient = null; }
    channel = ch;
    channel.binaryType = "arraybuffer";
    guestClient = new RemoteRefereeClient(oppTeam, (ab) => {
        bytesOut += ab.byteLength;
        if (channel && channel.readyState === "open") channel.send(ab);
    });
    registerClient(guestClient);
    channel.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) { bytesIn += ev.data.byteLength; guestClient!.handleBytes(ev.data); }
    };
}

function attachGuestRelay(): void {
    if (guestClient) return;
    guestClient = new RemoteRefereeClient(oppTeam, (ab) => { bytesOut += ab.byteLength; post({ kind: "net-out", data: ab }, [ab]); });
    registerClient(guestClient);
}

// ── Tick loop ─────────────────────────────────────────────────────────────────

function tick(): void {
    // While paused the scheduled loop no-ops here; a "step" sets `stepping` to force one tick.
    if ((simPaused && !stepping) || !started) return;
    const t0 = performance.now();

    // Validate then apply each client's commands (host first, then guest), then step.
    const applied: Command[] = [];
    for (const c of clients()) {
        const buf = pending.get(c)!.splice(0);
        if (!buf.length) continue;
        const valid = buf.filter(cmd => {
            if (cmd.type === CmdType.SPEED) { setSpeed(cmd.speed); return false; }   // control-plane, not simulated
            const ok = validateCommand(game.world, c.team, cmd);
            if (!ok) console.warn(`[referee] rejected illegal command from team ${c.team}`, cmd);
            return ok;
        });
        if (valid.length) { applied.push(...valid); game.applyCommands(valid); }
    }
    game.step();

    sendDebugCommands("host", game.world.tick, applied);
    sendDebugState(game.world, game.hashOwn(myTeam), "host");

    // Send each client its fog view (the client formats it — full for the host,
    // delta-encoded for the remote guest).  Echo each client's pingTs EXACTLY ONCE — in
    // the first snapshot after it arrives — then send 0.  Re-echoing the same pingTs every
    // tick made the guest's rtt = now − pingTs climb until the next ping (a 0→heartbeat-
    // interval sawtooth); consuming it means rtt reflects a true round-trip.
    for (const c of clients()) {
        const ping = lastPing.get(c) ?? 0;
        lastPing.delete(c);
        c.sendSnapshot(game.world.tick, fogSnapshot(c.team), ping, speed);
    }

    tickMs = performance.now() - t0;

    // Off the tickMs budget: record the reverse-debug history (all forward ticks, incl. manual steps),
    // then arm breakpoints — but only on the free-running loop, since a manual step is already a halt.
    recordHistory();
    // Dev-only diagnostics must never break the sim loop — isolate any throw.
    try { recordIncidentSnap(); detectPathologies(applied); }
    catch (e) { console.error("[referee] incident/pathology diagnostic threw (ignored):", e); sendDiagError(String((e as Error)?.stack ?? e)); }
    if (!stepping && (bpFns.length > 0 || dataBps.length > 0)) checkBreakpoints();
}

// ── Step debugger ───────────────────────────────────────────────────────────────

/** Snapshot the authoritative sim for the debugger's Variables panel (reuses unit snapshots). */
function buildDebugState(): SimDebugState {
    const units = game.unitEids().map((eid) => {
        const s = game.snapshotUnit(eid);
        return {
            uid: s.uid, type: s.type, team: s.team, x: s.x, y: s.y, dir: s.dir, moving: s.moving,
            moveActive: s.moveActive, mtx: s.mtx, mty: s.mty, fw: s.bw, fh: s.bh, buildLeft: s.buildLeft,
        };
    });
    return { tick: game.world.tick, paused: simPaused, hash: game.hashOwn(myTeam), units };
}

/** Advance exactly one tick through the pause gate, then report the halt + fresh state. */
function stepOnce(): void {
    stepping = true;
    try { tick(); } finally { stepping = false; }
    post({ kind: "stopped", tick: game.world.tick, reason: "step" });
    post({ kind: "debug-state", state: buildDebugState() });
}

/** Debug/e2e: advance exactly n ticks through the pause gate. The harness loads a scenario (which
 *  pauses), then steps a fixed count so results are deterministic and the per-tick state streams out. */
function stepTicks(n: number): void {
    const count = Math.max(1, Math.floor(n));
    for (let i = 0; i < count; i++) { stepping = true; try { tick(); } finally { stepping = false; } }
}

/** Debug/e2e: rebuild the sim from a tiny scenario (fresh map + explicit unit placements), left paused
 *  so the harness can step deterministically. createGame re-inits every grid (passability / occupancy /
 *  walk / path / local / vision), so this is a clean full reset. */
function loadScenario(sc: DebugScenario): void {
    seed = sc.seed ?? seed;
    mapW = sc.mapInfo.mapW;
    mapH = sc.mapInfo.mapH;
    currentMap = sc.mapInfo;
    game = createGame(seed, sc.mapInfo satisfies MapInfo);
    game.initUnitIdCounter(0);
    for (const u of sc.spawns) {
        game.spawnUnit(tileCenterFP(u.tx), tileCenterFP(u.ty), u.team, undefined, u.typeId ?? 0);
    }
    for (const b of sc.buildings ?? []) {
        const beid = game.spawnBuilding(b.tx, b.ty, b.team, b.typeId);   // footprint top-left tile
        Building.buildLeft[beid] = 0;   // scenarios place finished buildings (render the real sprite, not a construction site)
    }
    revealAll();   // scenarios test obstacle routing with full map knowledge (no fog-of-war discovery)
    simPaused = true;
    started   = true;
    history.length = 0;
    resetIncidentState();   // old session's snapshots / pathology tracking must not bleed into a new scenario
    post({ kind: "ready", passability: getPassability(), mapW, mapH });
    post({ kind: "scenario-map", gids: scenarioRenderGids(), mapW, mapH });   // redraw the terrain
    renderHost();                                                // initial frame to the host renderer
    sendDebugState(game.world, game.hashOwn(myTeam), "host");    // tick-0 state for the inspector/harness
}

/** Build terrain GIDs for the loaded scenario: plain grass for walkable tiles, an impassable tile for
 *  blocked. These are FOREST-tileset GIDs — the renderer draws scenarios from the "forest" sheet (a
 *  clean grass look), independent of whatever tileset the boot map used. */
function scenarioRenderGids(): number[] {
    const pass = getPassability();   // 0 = walkable, 1 = blocked, for the loaded scenario
    const GRASS = 357;   // forest plain-grass tile (most uniform green LAND tile in forest.png)
    const WALL  = 17;    // forest stone-wall tile (3rd-from-last, first row) — reads as impassable
    const out = new Array<number>(pass.length);
    for (let i = 0; i < pass.length; i++) out[i] = pass[i] ? WALL : GRASS;
    return out;
}

// ── Breakpoints ─────────────────────────────────────────────────────────────────
// Expressions are compiled to plain functions over a fixed vocabulary (no `with` — workers are
// strict-mode modules). `new Function` only closes over globals + its named args, so the expression
// can't reach worker internals. A bad expression is dropped at compile time and ignored at eval time.

function setBreakpoints(exprs: string[]): void {
    bpFns = [];
    for (const src of exprs) {
        try { bpFns.push({ src, fn: new Function("tick", "units", "hash", "paused", "count", "team", "unit", `return (${src});`) as BpFn }); }
        catch (error) { console.warn("[referee] ignoring invalid breakpoint expression:", src, error); }
    }
    bpPrev = bpFns.map(() => false);   // a condition already true when set fires on the next tick
}

function setDataBreakpoints(ids: string[]): void {
    dataBps = ids;
    dataPrev.clear();                  // first observation per id just seeds; only changes fire
}

/** Resolve a dataId (`sim.<field>` | `unit.<uid>.<field>`) against the current state to a number. */
function readData(state: SimDebugState, id: string): number | undefined {
    const parts = id.split(".");
    if (parts[0] === "sim") return (state as unknown as Record<string, number>)[parts[1]!];
    if (parts[0] === "unit") {
        const u = state.units.find((x) => x.uid === Number(parts[1]));
        return u ? (u as unknown as Record<string, number>)[parts[2]!] : undefined;
    }
    return undefined;
}

/** Build the argument tuple a breakpoint expression is evaluated with (see setBreakpoints). */
function bpArgs(state: SimDebugState): [number, SimDebugUnit[], number, boolean, number, (t: number) => number, (uid: number) => SimDebugUnit | undefined] {
    const units = state.units;
    return [state.tick, units, state.hash, state.paused, units.length,
        (t) => units.filter((u) => u.team === t).length,
        (uid) => units.find((u) => u.uid === uid)];
}

/** True if any breakpoint expression holds for the current state (level, not edge) — for reverse run. */
function anyExprTrue(): boolean {
    const args = bpArgs(buildDebugState());
    for (const bp of bpFns) {
        try { if (bp.fn(...args)) return true; } catch { /* ignore eval error */ }
    }
    return false;
}

/** Called each running tick: halt on the rising edge of any expression, or on any watched data
 *  change. Edge-triggered so `continue` runs on rather than re-breaking while a condition stays true. */
function checkBreakpoints(): void {
    const state = buildDebugState();
    const args = bpArgs(state);

    let firstHit = -1;
    for (let i = 0; i < bpFns.length; i++) {
        let hit = false;
        try { hit = Boolean(bpFns[i]!.fn(...args)); }
        catch { /* runtime eval error (e.g. unit(uid) undefined) → treat as not hit */ }
        if (hit && !bpPrev[i] && firstHit < 0) firstHit = i;
        bpPrev[i] = hit;
    }
    if (firstHit >= 0) { breakOn(`breakpoint: ${bpFns[firstHit]!.src}`, state); return; }

    for (const id of dataBps) {
        const cur = readData(state, id);
        if (cur === undefined) continue;
        const prev = dataPrev.get(id);
        dataPrev.set(id, cur);
        if (prev !== undefined && prev !== cur) { breakOn(`data: ${id} (${prev} → ${cur})`, state); return; }
    }
}

function breakOn(hit: string, state: SimDebugState): void {
    simPaused = true;
    state.paused = true;   // the snapshot was taken pre-pause; reflect the halt we're entering
    post({ kind: "stopped", tick: game.world.tick, reason: "breakpoint", hit });
    post({ kind: "debug-state", state });
}

// ── Reverse debugging ─────────────────────────────────────────────────────────────
// The sim is deterministic, so a per-tick snapshot ring is enough to travel backwards. Recording is
// gated on `historyEnabled` (set while a debug session is attached) to keep it off the normal path.

/** Record the post-step state. Stepping forward after a rewind forks the timeline, so drop any now-
 *  stale "future" snapshots first; then cap the ring. */
function recordHistory(): void {
    if (!historyEnabled) return;
    const t = game.world.tick;
    while (history.length > 0 && history[history.length - 1]!.tick >= t) history.pop();
    history.push({ tick: t, snap: game.takeSnapshot() });
    while (history.length > HISTORY_MAX) history.shift();
}

/** Dev-only: feed the incident snapshot ring (~every 1.5 s) so a flag has lead-up to replay. */
function recordIncidentSnap(): void {
    if (!import.meta.env.DEV) return;
    const t = game.world.tick;
    if (t % INCIDENT_SNAP_EVERY !== 0) return;
    incidentRing.push({ tick: t, snap: game.takeSnapshot() });
    while (incidentRing.length > INCIDENT_RING_MAX) incidentRing.shift();
}

/** Capture the current moment as a replayable incident: the oldest buffered snapshot (max lead-up) plus
 *  the map, shipped to the debug server (which enriches it with the recent command log). */
function flagIncident(label: string): void {
    if (!currentMap) return;
    const base = incidentRing[0] ?? { tick: game.world.tick, snap: game.takeSnapshot() };
    // flagHash = own-team hash at the flag tick; the regression runner replays base→flag and asserts it
    // matches, proving the captured repro reproduces exactly before checking the outcome.
    sendIncident({ flagTick: game.world.tick, baseTick: base.tick, snapshot: base.snap, map: currentMap, flagHash: game.hashOwn(myTeam), label });
    console.info(`[referee] incident flagged: base tick ${base.tick} → flag tick ${game.world.tick}`);
}

/** Clear detector + incident state — a new scenario/replay must start with a clean slate. */
function resetIncidentState(): void {
    incidentRing.length = 0;
    pathoTracks.clear();
    autoFlagged.clear();
    pathoCount = -1;
    lastAutoFlag = -1e9;
}

/**
 * Read-only post-step scan for pathing pathologies — never mutates the sim (determinism holds). Flags a
 * unit as: GIVE-UP (ordered to move this tick but ended it idle and not at the target), STUCK (moving but
 * grinding near the settle limit), SETTLED-SHORT (settled because walled, not arrived), or OSCILLATING
 * (tile bouncing A↔B). Pushes the live count to the HUD and auto-flags a sustained episode (debounced).
 */
function detectPathologies(applied: Command[]): void {
    if (!import.meta.env.DEV) return;
    const tick = game.world.tick;
    const bad = new Map<number, string>();   // uid → pathology kind (first/worst wins)

    // GIVE-UP: a unit commanded to move this tick that ended it not moving and not at the target tile.
    for (const cmd of applied) {
        if (cmd.type !== CmdType.MOVE) continue;
        const ttx = fpToTile(cmd.txFP), tty = fpToTile(cmd.tyFP);
        for (const uid of cmd.unitIds) {
            const eid = game.eidForUnitId(uid);
            if (eid !== undefined && MoveTarget.active[eid] === 0 && (Path.curTx[eid] !== ttx || Path.curTy[eid] !== tty)) bad.set(uid, "give-up");
        }
    }

    for (const eid of game.unitEids()) {
        if (hasComponent(game.world, eid, Building) || Unit.movable[eid] !== 1) continue;
        const uid = UnitId.id[eid];
        const move = MoveTarget.active[eid];
        const stuck = Path.stuckTicks[eid];
        const tileKey = Path.curTy[eid] * 4096 + Path.curTx[eid];
        const tr = pathoTracks.get(uid) ?? { prevMove: 0, prevSlotTx: -999, prevSlotTy: -999, tiles: [], stuckSince: -1 };

        // STUCK: moving but grinding toward the settle limit.
        if (move === 1 && stuck >= STUCK_FLAG) { if (!bad.has(uid)) bad.set(uid, "stuck"); if (tr.stuckSince < 0) tr.stuckSince = tick; }
        else tr.stuckSince = -1;

        // SETTLED-SHORT: just settled (move 1→0) more than a tile from the slot it was steering toward
        // (its last live MoveTarget) — it stopped somewhere other than where it was ordered, for ANY
        // reason (walled, slot taken, reflow), not just the walled case.
        if (tr.prevMove === 1 && move === 0 && !bad.has(uid)
            && Math.abs(Path.curTx[eid] - tr.prevSlotTx) + Math.abs(Path.curTy[eid] - tr.prevSlotTy) > 1) bad.set(uid, "settled-short");

        // OSCILLATION: bouncing between ≤2 tiles over the last OSC_WINDOW distinct-consecutive tiles
        // (a clean A↔B 2-cycle that persists, not a one-off detour).
        if (tr.tiles[tr.tiles.length - 1] !== tileKey) { tr.tiles.push(tileKey); if (tr.tiles.length > OSC_WINDOW) tr.tiles.shift(); }
        if (move === 1 && tr.tiles.length >= OSC_WINDOW && new Set(tr.tiles).size <= 2 && !bad.has(uid)) bad.set(uid, "oscillating");

        tr.prevMove = move;
        if (move === 1) { tr.prevSlotTx = fpToTile(MoveTarget.tx[eid]); tr.prevSlotTy = fpToTile(MoveTarget.ty[eid]); }
        pathoTracks.set(uid, tr);
    }

    // Prune tracking for despawned units so the maps can't grow unbounded.
    if (pathoTracks.size > 512) for (const uid of [...pathoTracks.keys()]) if (game.eidForUnitId(uid) === undefined) pathoTracks.delete(uid);

    if (bad.size !== pathoCount) { pathoCount = bad.size; post({ kind: "pathology", n: bad.size }); }

    // Auto-flag the worst current pathology (debounced + per-signature dedup): an instantaneous event, or
    // a stuck unit that's persisted — but never the same unit+kind twice within AUTOFLAG_DEDUP.
    if (bad.size > 0 && tick - lastAutoFlag >= AUTOFLAG_COOLDOWN) {
        let pick: { uid: number; kind: string; sig: string } | null = null;
        for (const [uid, kind] of bad) {
            const sig = `${kind}:${uid}`;
            if (tick - (autoFlagged.get(sig) ?? -1e9) < AUTOFLAG_DEDUP) continue;   // recently flagged this exact pathology
            if (kind === "give-up" || kind === "settled-short") { pick = { uid, kind, sig }; break; }
            const tr = pathoTracks.get(uid);
            if (kind === "stuck" && tr && tr.stuckSince >= 0 && tick - tr.stuckSince >= AUTOFLAG_SUSTAIN) pick = { uid, kind, sig };
        }
        if (pick) { lastAutoFlag = tick; autoFlagged.set(pick.sig, tick); flagIncident(`auto: ${pick.kind} uid${pick.uid}`); }
    }
}

/** Replay an incident: rebuild the sim on its map, restore its snapshot, leave it paused for stepping. */
function restoreIncident(snap: WorldSnapshot, map: MapInfo): void {
    currentMap = map;
    mapW = map.mapW;
    mapH = map.mapH;
    game = createGame(seed, map satisfies MapInfo);
    game.applySnapshot(snap);            // restores units / explored / rng / tick onto the rebuilt map
    simPaused = true;
    started   = true;
    history.length = 0;
    resetIncidentState();
    post({ kind: "ready", passability: getPassability(), mapW, mapH });
    post({ kind: "scenario-map", gids: scenarioRenderGids(), mapW, mapH });
    renderHost();
    sendDebugState(game.world, game.hashOwn(myTeam), "host");
}

/** Push the current (e.g. just-rewound) state to the host's renderer, leaving the guest untouched. */
function renderHost(): void {
    hostClient.sendSnapshot(game.world.tick, fogSnapshot(myTeam), 0, speed);
}

/** Restore the newest recorded snapshot strictly before the current tick (one reverse step). */
function stepBack(): void {
    let idx = -1;
    for (let i = history.length - 1; i >= 0; i--) { if (history[i]!.tick < game.world.tick) { idx = i; break; } }
    simPaused = true;
    if (idx >= 0) {
        game.applySnapshot(history[idx]!.snap);
        while (history.length > idx + 1) history.pop();   // restored tick becomes the ring head
        renderHost();
    }
    post({ kind: "stopped", tick: game.world.tick, reason: "step" });
    post({ kind: "debug-state", state: buildDebugState() });
}

/** Rewind toward the earliest snapshot, stopping at the first earlier tick where a breakpoint
 *  expression holds (level-triggered — the most recent prior point the condition was true). */
function reverseContinue(): void {
    let hitBp = false;
    while (history.length > 1) {
        let idx = -1;
        for (let i = history.length - 1; i >= 0; i--) { if (history[i]!.tick < game.world.tick) { idx = i; break; } }
        if (idx < 0) break;
        game.applySnapshot(history[idx]!.snap);
        while (history.length > idx + 1) history.pop();
        if (bpFns.length > 0 && anyExprTrue()) { hitBp = true; break; }
    }
    simPaused = true;
    renderHost();
    post({ kind: "stopped", tick: game.world.tick, reason: hitBp ? "breakpoint" : "step", hit: hitBp ? "reverse-continue" : undefined });
    post({ kind: "debug-state", state: buildDebugState() });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function start(init: WorkerInit): void {
    myTeam  = init.myTeam;          // host
    oppTeam = 1 - myTeam;
    mapW    = init.mapW;
    mapH    = init.mapH;
    seed    = init.seed;

    currentMap = init.mapInfo;
    game = createGame(init.seed, init.mapInfo satisfies MapInfo);
    game.initUnitIdCounter(0);      // single id space — the referee mints every unit

    for (const s of init.spawns) {
        for (let i = 0; i < s.count; i++) {
            game.spawnUnit(tileCenterFP(s.sx + (i % 2)), tileCenterFP(s.sy + Math.floor(i / 2)), s.team, undefined, s.typeId);
        }
    }

    // Host plays in-process: its snapshot becomes a render message; its commands
    // arrive via the "command" message pump (see deliverCommands below).
    hostClient = new LocalRefereeClient(myTeam, (payload) => post({ kind: "render", state: toRenderState(payload) }));
    registerClient(hostClient);

    initDebugClient("host");
    setDebugCallbacks({
        onPause:          () => { simPaused = true;  },
        onResume:         () => { simPaused = false; },
        onInspectorCount: (n) => post({ kind: "inspector-count", n }),
        // e2e/debug driving (from the debug server — Playwright harness or MCP):
        // Queue like a real command so it's validated, applied AND logged next tick (so the
        // command-log–based tools — summarize_move / trace — see test-driven moves too).
        onCommand:        (cmd) => { if (started) hostClient.deliverCommands([cmd], 0); },
        onStep:           (n)   => { if (started) stepTicks(n); },                // advance N ticks (load paused first)
        onLoadScenario:   (sc)  => loadScenario(sc),                              // rebuild from a tiny map
        onLabel:          (text) => post({ kind: "scenario-label", text }),       // e2e: show the running test name
        onFlag:           (label) => flagIncident(label),                         // capture a pathing incident
        onRestore:        (snap, map) => restoreIncident(snap, map),              // replay a captured incident
    });

    started = true;
    post({ kind: "ready", passability: getPassability(), mapW, mapH });

    scheduleTick();                          // self-rescheduling so game speed can change the cadence
    setInterval(emitMetrics, METRICS_MS);
    setInterval(emitSnapshot, SNAPSHOT_MS);
}

// ── Message pump ────────────────────────────────────────────────────────────────

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
    const msg = ev.data;
    switch (msg.kind) {
        case "init":    start(msg.init); break;
        case "restore": game.applySnapshot(msg.snap); console.info(`[referee] restored from snapshot at tick ${msg.snap.tick}`); break;
        case "channel": attachGuestChannel(msg.channel); break;
        case "net-in":  attachGuestRelay(); bytesIn += msg.data.byteLength; guestClient!.handleBytes(msg.data); break;
        case "command": hostClient.deliverCommands([msg.cmd], 0); break;
        case "pause":   simPaused = true;  post({ kind: "stopped", tick: game.world.tick, reason: "pause" }); post({ kind: "debug-state", state: buildDebugState() }); break;
        case "resume":  simPaused = false; break;
        case "step":    stepOnce(); break;
        case "debug-state-request": post({ kind: "debug-state", state: buildDebugState() }); break;
        case "set-breakpoints":      setBreakpoints(msg.exprs); break;
        case "set-data-breakpoints": setDataBreakpoints(msg.ids); break;
        case "set-reverse":          historyEnabled = msg.enabled; if (!msg.enabled) history.length = 0; break;
        case "step-back":            stepBack(); break;
        case "reverse-continue":     reverseContinue(); break;
        case "flag-incident":        flagIncident(msg.label ?? ""); break;
        case "client-console":       relayClientConsole(msg.level, msg.msg); break;   // relay this box's main-thread console
    }
};
