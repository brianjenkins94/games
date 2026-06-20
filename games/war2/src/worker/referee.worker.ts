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
import { UnitId, TICK_MS, tileCenterFP } from "../game/components";
import { CmdType, type Command, type UnitSnapshot, type StateUpdatePayload } from "../net/protocol";
import { LocalRefereeClient, RemoteRefereeClient, type RefereeClient } from "../net/transport";
import { getPassability } from "../game/passability";
import { initDebugClient, sendDebugState, sendDebugCommands, setDebugCallbacks } from "../debug/client";
import {
    renderUnitFromSnapshot,
    type MainToWorker, type WorkerToMain, type RenderState, type MetricsSample, type WorkerInit, type SimDebugState, type SimDebugUnit,
} from "./ipc";

const post = (msg: WorkerToMain, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);

// ── Runtime state ─────────────────────────────────────────────────────────────

let game!: GameInstance;
let myTeam   = 0;          // the host's team
let oppTeam  = 1;          // the guest's team
let mapW = 0, mapH = 0;
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
    tickTimer = setTimeout(() => { tickTimer = undefined; tick(); scheduleTick(); }, TICK_MS / speed);
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

// ── Networking (guest channel: transferred, else relayed through host main) ──────

let channel: RTCDataChannel | null = null;

function attachGuestChannel(ch: RTCDataChannel): void {
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
    });

    started = true;
    post({ kind: "ready", passability: getPassability(), mapW, mapH });

    scheduleTick();                          // self-rescheduling so game speed can change the cadence
    setInterval(emitMetrics, METRICS_MS);
}

// ── Message pump ────────────────────────────────────────────────────────────────

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
    const msg = ev.data;
    switch (msg.kind) {
        case "init":    start(msg.init); break;
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
    }
};
