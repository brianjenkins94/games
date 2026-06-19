/**
 * Predictive client worker (guest).
 *
 * The referee (host) is authoritative, but the guest's own units would otherwise
 * only move ~RTT after a command (command → referee → fog snapshot → render).  To
 * hide that latency this worker runs a *local predictive sim of the guest's own
 * units only* — the same deterministic movement + flow field the referee runs — so
 * commands take effect instantly and units follow the real path (not a rubber-
 * banding straight-line guess).  The referee stays the sole authority; this is a
 * throwaway prediction reconciled against every authoritative snapshot.
 *
 *   • own units  — created/updated from snapshots, then predicted forward each tick;
 *                  snapped back only when prediction diverges past RECONCILE_SNAP.
 *   • enemy units — display-only in the local sim (kept in the occupancy grid so
 *                   own-unit prediction routes around them, never onto them);
 *                   positioned purely from snapshots, never simulated.
 *
 * Runs in a Worker so prediction + network I/O survive tab backgrounding.
 */
import { createGame, type GameInstance, type MapInfo } from "../game/game";
import { Unit, UnitId, TICK_MS, TILE_PX, FP } from "../game/components";
import { distance } from "../game/distance";
import { getPassability } from "../game/passability";
import {
    CmdType, encodeClientCommand, decodeStateUpdate, packetType, PacketType,
    type Command,
} from "../net/protocol";
import {
    renderUnitFromSnapshot,
    type MainToWorker, type WorkerToMain, type RenderState, type RenderUnit, type MetricsSample, type WorkerInit,
} from "./ipc";

const post = (msg: WorkerToMain, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);

// Divergence that snaps a predicted unit back to authority (FP).  While a unit is
// still moving, tolerate up to 2 tiles so the normal ~RTT lead doesn't snap; once
// authority reports it STOPPED its position is final (no lead), so a tight tolerance
// corrects a unit that predicted onto an enemy tile authority settled adjacent to.
const RECONCILE_MOVING  = 2 * TILE_PX * FP;
const RECONCILE_STOPPED = (TILE_PX * FP) >> 1;   // half a tile

let game!: GameInstance;
let myTeam = 1;
let simPaused = false;
let started = false;

// Game-speed multiplier — taken from each referee snapshot (the referee is authoritative). Scales
// only the local predictive-tick cadence so prediction keeps pace with the referee; the logical
// timestep is unchanged, so reconciliation still works. Self-rescheduling so it can change live.
let speed = 1;
let tickTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleTick(): void {
    if (tickTimer !== undefined) clearTimeout(tickTimer);
    tickTimer = setTimeout(() => { tickTimer = undefined; tick(); scheduleTick(); }, TICK_MS / speed);
}

// Perf probes (flushed to the host page ~4 Hz, off the render hot path).
const METRICS_MS = 250;
let rtt        = 0;   // ms round-trip to the referee (heartbeat-refreshed)
let serverTick = 0;   // last authoritative tick seen
let clientTick = 0;   // local predictive tick
let tickMs     = 0;   // duration of the most recent predictive step
let bytesIn    = 0;   // from the channel, accumulated since the last flush
let bytesOut   = 0;   // to the channel, accumulated since the last flush

let channel: RTCDataChannel | null = null;

function sendToReferee(cmds: Command[]): void {
    const ab = encodeClientCommand({ cmds, pingTs: performance.now() });
    bytesOut += ab.byteLength;
    if (channel && channel.readyState === "open") channel.send(ab);
    else post({ kind: "net-out", data: ab }, [ab]);   // relay through host main
}

// ── Authoritative reconciliation ────────────────────────────────────────────────

function onBytes(ab: ArrayBuffer): void {
    bytesIn += ab.byteLength;
    if (packetType(ab) !== PacketType.STATE_UPDATE) return;
    const p = decodeStateUpdate(ab);
    if (p.pingTs > 0) rtt = Math.round(performance.now() - p.pingTs);
    if (p.speed > 0 && p.speed !== speed) { speed = p.speed; scheduleTick(); }   // match the referee's cadence
    serverTick = p.tick;

    // Apply the units in this packet (full set on a keyframe, changed/new on a delta).
    const seen = new Set<number>();
    for (const s of p.visibleStates) {
        seen.add(s.uid);
        const eid = game.eidForUnitId(s.uid);
        if (s.team === myTeam) {
            // Own units: predicted — add new, else snap only if prediction diverged.
            if (eid === undefined) {
                game.addOwnUnit(s);
            } else {
                const pred = game.snapshotUnit(eid);
                const tol = s.moveActive ? RECONCILE_MOVING : RECONCILE_STOPPED;
                if (distance(pred.x - s.x, pred.y - s.y) > tol) game.reconcileOwnUnit(eid, s);
            }
        } else {
            // Enemies: display-only, but kept in the occupancy grid so own-unit
            // prediction routes around them (never onto a host unit).
            if (eid === undefined) game.addKnownUnit(s); else game.updateKnownUnit(eid, s);
        }
    }

    if (p.keyframe) {
        // Full set: anything absent is gone (own died, enemy left sight).
        for (const eid of game.unitEids()) {
            if (seen.has(UnitId.id[eid])) continue;
            if (Unit.team[eid] === myTeam) game.despawnUnit(eid);
            else                          game.removeKnownUnit(eid);
        }
    } else {
        // Delta: only the explicitly-removed uids are gone; absence means unchanged.
        for (const uid of p.removed) {
            const eid = game.eidForUnitId(uid);
            if (eid === undefined) continue;
            if (Unit.team[eid] === myTeam) game.despawnUnit(eid);
            else                          game.removeKnownUnit(eid);
        }
    }
}

// ── Local prediction tick ────────────────────────────────────────────────────────

function tick(): void {
    if (simPaused || !started) return;
    const t0 = performance.now();
    game.step();                       // advance predicted own units along the real flow field
    clientTick = game.world.tick;
    tickMs = performance.now() - t0;
    post({ kind: "render", state: buildRenderState() });
}

function buildRenderState(): RenderState {
    // Own units (predicted) + enemies (display-only) both live in the local game.
    const units: RenderUnit[] = [];
    for (const eid of game.unitEids()) units.push(renderUnitFromSnapshot(game.snapshotUnit(eid)));
    return { tick: game.world.tick, units };
}

function emitMetrics(): void {
    let units = 0;
    for (const _ of game.unitEids()) units++;
    const sample: MetricsSample = { tickMs, rtt, lead: serverTick - clientTick, units, bytesIn, bytesOut };
    bytesIn = bytesOut = 0;
    post({ kind: "metrics", sample });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function start(init: WorkerInit): void {
    myTeam = init.myTeam;
    game = createGame(init.seed, init.mapInfo satisfies MapInfo);   // local predictive sim (own units seeded from snapshots)
    started = true;
    post({ kind: "ready", passability: getPassability(), mapW: init.mapW, mapH: init.mapH });

    scheduleTick();                              // self-rescheduling so game speed can change the cadence
    setInterval(() => sendToReferee([]), 500);   // heartbeat keeps RTT fresh
    setInterval(emitMetrics, METRICS_MS);
}

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
    const msg = ev.data;
    switch (msg.kind) {
        case "init":    start(msg.init); break;
        case "channel":
            channel = msg.channel;
            channel.binaryType = "arraybuffer";
            channel.onmessage = (e) => { if (e.data instanceof ArrayBuffer) onBytes(e.data); };
            break;
        case "net-in":  onBytes(msg.data); break;            // relay inbound
        case "command":
            // Predict MOVE/STOP locally for instant response; SPAWN/BUILD aren't
            // predicted (the referee mints ids).  Everything is sent to the referee.
            if (msg.cmd.type === CmdType.MOVE || msg.cmd.type === CmdType.STOP) game.applyCommands([msg.cmd]);
            sendToReferee([msg.cmd]);
            break;
        case "pause":   simPaused = true;  break;
        case "resume":  simPaused = false; break;
    }
};
