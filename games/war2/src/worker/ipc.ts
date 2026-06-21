/**
 * Worker IPC protocol — the message contract between a main thread (client shell)
 * and its worker.  Host-authoritative model: the host spawns the *referee* worker
 * (referee.worker.ts, authoritative sim of both teams); the guest spawns a *thin
 * client* worker (client.worker.ts) that just relays over the data channel.  Both
 * mains use this same contract — postMessage commands out, receive render
 * snapshots in — so the client shell is role-agnostic on the hot path.
 *
 * Workers keep ticking / doing I/O when the tab is backgrounded (main-thread
 * timers throttle; worker timers and message handling do not).  PeerJS lives on
 * the main thread (RTCPeerConnection isn't available in workers); the established
 * RTCDataChannel is transferred into the worker (Chromium), else raw packets are
 * relayed via net-in/net-out.
 *
 * This module is shared by both threads and must stay free of Phaser/DOM imports.
 */
import type { Command, UnitSnapshot } from "../net/protocol";
import type { MapInfo, WorldSnapshot } from "../game/world";

// ── Render snapshot (worker → main, every tick) ──────────────────────────────────

/** One entity's per-tick render state.  Keyed by stable `uid` (eids are
 *  worker-internal).  Buildings carry fw/fh > 0; mobile units have fw === 0. */
export interface RenderUnit {
    uid:      number;
    type:     number;   // interned unit-type id (unitTypes.ts)
    team:     number;
    x:        number;   // FP world coords
    y:        number;
    dir:      number;
    moving:   number;
    mtActive: number;   // MoveTarget.active (drives the move dot — own units only)
    mtx:      number;
    mty:      number;
    fw:       number;   // building footprint (tiles); 0 for mobile units
    fh:       number;
    buildLeft: number;
}

export interface RenderState {
    tick:  number;
    units: RenderUnit[];
}

// ── Metrics sample (worker → main, ~4 Hz; off the render hot path) ────────────────

/** A worker's periodic perf sample.  The main thread adds `fps`/`frameMs` (which only
 *  it can see) and forwards the lot to the host page, where the metrics package charts
 *  it per box (host vs guest).  `bytesIn`/`bytesOut` are byte counts accumulated since
 *  the previous sample (the metrics package converts to a rate using the timestamps).
 *  `rtt`/`lead` are wire-only signals: the host plays in-process so both read 0 there. */
export interface MetricsSample {
    tickMs:   number;   // sim step duration this interval's last tick (vs TICK_MS budget)
    rtt:      number;   // ms round-trip to the referee (guest only; 0 for the in-process host)
    lead:     number;   // serverTick − clientTick (guest desync early-warning; 0 for host)
    units:    number;   // entities the worker is tracking (correlate axis)
    bytesIn:  number;   // bytes received over the channel since the last sample
    bytesOut: number;   // bytes sent over the channel since the last sample
}

/** Build a RenderUnit from a fog-view UnitSnapshot (shared by host + guest render). */
export function renderUnitFromSnapshot(s: UnitSnapshot): RenderUnit {
    return {
        uid: s.uid, type: s.type, team: s.team, x: s.x, y: s.y,
        dir: s.dir, moving: s.moving, mtActive: s.moveActive, mtx: s.mtx, mty: s.mty,
        fw: s.bw, fh: s.bh, buildLeft: s.buildLeft,
    };
}

// ── Init payload ─────────────────────────────────────────────────────────────────

/** One team's initial unit spawn (top-left tile, count, interned worker type). */
export interface SpawnConfig { team: number; sx: number; sy: number; count: number; typeId: number; }

export interface WorkerInit {
    role:        "host" | "peer";
    myTeam:      number;
    seed:        number;
    mapInfo:     MapInfo;
    /** All teams' initial spawns — the referee creates them; the thin guest worker
     *  ignores this (it doesn't simulate). */
    spawns:      SpawnConfig[];
    mapW:        number;
    mapH:        number;
}

// ── Step-debug state (worker → main, on request / when stopped) ──────────────────

/** One entity, formatted for the debugger's Variables tree (a flat per-unit bag of components). */
export interface SimDebugUnit {
    uid: number; type: number; team: number;
    x: number; y: number; dir: number; moving: number;
    moveActive: number; mtx: number; mty: number;
    fw: number; fh: number; buildLeft: number;
}

/** A snapshot of the authoritative sim for the debugger (tick + paused flag + every unit). The
 *  DAP adapter maps this onto VS Code's Variables panel; cheap to build (reuses unit snapshots). */
export interface SimDebugState {
    tick:   number;
    paused: boolean;
    hash:   number;          // own-team world hash (desync / change detection)
    units:  SimDebugUnit[];
}

// ── Messages: main → worker ──────────────────────────────────────────────────────

export type MainToWorker =
    | { kind: "init";    init: WorkerInit }
    /** Transferred raw data channel (Chromium fast path). */
    | { kind: "channel"; channel: RTCDataChannel }
    /** Relay fallback: an incoming raw packet to process. */
    | { kind: "net-in";  data: ArrayBuffer }
    /** A locally-issued command to queue for the next tick. */
    | { kind: "command"; cmd: Command }
    /** Reverse/popout restore: boot the referee from this snapshot instead of the seed, so a host box
     *  that reloaded (e.g. popped out into its own tab) resumes the game rather than reseeding it. */
    | { kind: "restore"; snap: WorldSnapshot }
    | { kind: "pause" }
    | { kind: "resume" }
    /** Step debugger: advance exactly one tick while paused, then re-pause. */
    | { kind: "step" }
    /** Step debugger: send a fresh SimDebugState (for the Variables panel). */
    | { kind: "debug-state-request" }
    /** Conditional breakpoints: JS expressions evaluated against the sim each tick; the sim halts
     *  on the rising edge of any. Vocabulary: tick, units, hash, paused, count, team(t), unit(uid). */
    | { kind: "set-breakpoints"; exprs: string[] }
    /** Data breakpoints: dataIds (`sim.hash`, `unit.<uid>.<field>`) watched for change each tick. */
    | { kind: "set-data-breakpoints"; ids: string[] }
    /** Reverse debugging: enable/disable per-tick snapshot recording (on while a session is attached). */
    | { kind: "set-reverse"; enabled: boolean }
    /** Reverse debugging: restore the previous tick from the snapshot ring (one reverse step). */
    | { kind: "step-back" }
    /** Reverse debugging: rewind until a breakpoint expression holds, or to the earliest snapshot. */
    | { kind: "reverse-continue" };

// ── Messages: worker → main ──────────────────────────────────────────────────────

export type WorkerToMain =
    | { kind: "ready"; passability: Uint8Array | null; mapW: number; mapH: number }
    /** Per-tick render snapshot. */
    | { kind: "render"; state: RenderState }
    /** Periodic perf sample (~4 Hz). */
    | { kind: "metrics"; sample: MetricsSample }
    /** Referee only: a periodic full snapshot, relayed to the host page so it can restore the game
     *  into a reloaded host box (popout/re-attach/crash). Authoritative state survives the reboot. */
    | { kind: "snapshot"; snap: WorldSnapshot }
    /** Debug/e2e: a scenario was loaded — redraw the terrain. `gids` are real tileset frame ids
     *  (grass for walkable, wall for blocked), one per tile, mapW×mapH; the renderer rebuilds. */
    | { kind: "scenario-map"; gids: number[]; mapW: number; mapH: number }
    /** Relay fallback: a raw packet to send over the channel. */
    | { kind: "net-out"; data: ArrayBuffer }
    /** Debug inspector badge count (worker owns the debug WS; badge is DOM). */
    | { kind: "inspector-count"; n: number }
    /** Step debugger: the sim halted (manual pause, a completed step, or a breakpoint hit). `hit`
     *  describes the matched breakpoint (the expression, or the changed dataId). */
    | { kind: "stopped"; tick: number; reason: "pause" | "step" | "breakpoint"; hit?: string }
    /** Step debugger: requested/owed sim state for the Variables panel. */
    | { kind: "debug-state"; state: SimDebugState };
