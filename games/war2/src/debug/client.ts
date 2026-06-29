/**
 * Debug client — browser side.
 *
 * Connects to tools/debug-server.mjs and:
 *   • Pushes a JSON state blob after every sim tick.
 *   • Pushes the command list applied each tick (for deterministic replay).
 *   • Listens for ctrl messages (pause / resume) from the inspector.
 *
 * Only active in dev builds; tree-shaken in production.
 */

import { Position, Unit, UnitId, Path, MoveTarget, UnitAnim, fpToTile } from '../game/components';
import { unitBoxHalfPx } from '../game/unitTypes';
import { debugReservedRegion } from '../game/walkGrid';
import type { MapInfo, SimWorld } from '../game/world';
import { unitEids } from '../game/world';
import type { WorldSnapshot } from '../game/snapshot';
import type { Command } from '../net/protocol';
import { forwardWorkerConsole } from './workerConsole';

/** A flagged pathing incident, shipped to the debug server for retroactive analysis. */
export interface IncidentCapture {
    flagTick:  number;
    baseTick:  number;          // tick of `snapshot` — the lead-up start
    snapshot:  WorldSnapshot;   // full deterministic state → exact replay
    map:       MapInfo;         // the map it was captured on (self-contained repro)
    flagHash:  number;          // own-team hash at flagTick — the runner's replay-faithfulness check
    label:     string;
}

/** A tiny e2e/debug scenario: a fresh map + explicit per-unit placements (tile coords). The referee
 *  rebuilds the sim from this (paused) so a test can step deterministically. See referee.worker.ts. */
export interface DebugScenario {
    seed?: number;
    mapInfo: MapInfo;
    spawns: { team: number; tx: number; ty: number; typeId?: number }[];
    /** Buildings to place (footprint top-left tile); typeId must be a multi-tile building type. */
    buildings?: { team: number; tx: number; ty: number; typeId: number }[];
}

// Runs in the sim worker (WebSocket works there; the sim state it serialises now
// lives there too).  The only DOM concern — the inspector badge — is delegated to
// the main thread via the onInspectorCount callback, so this module stays
// worker-safe (no `document`).

const DEBUG_WS_URL = 'ws://localhost:9229';

let socket: WebSocket | null = null;
let _onPause:  (() => void) | null = null;
let _onResume: (() => void) | null = null;
let _onInspectorCount: ((n: number) => void) | null = null;
let _onCommand:      ((cmd: Command) => void) | null = null;
let _onStep:         ((n: number) => void) | null = null;
let _onLoadScenario: ((sc: DebugScenario) => void) | null = null;
let _onLabel:        ((text: string) => void) | null = null;
let _onFlag:         ((label: string) => void) | null = null;
let _onRestore:      ((snap: WorldSnapshot, map: MapInfo) => void) | null = null;

// ── Init ──────────────────────────────────────────────────────────────────────

export function initDebugClient(role: string): void {
    if (!import.meta.env.DEV) return;

    try {
        socket = new WebSocket(DEBUG_WS_URL);

        socket.addEventListener('open', () => {
            socket!.send(JSON.stringify({ type: 'hello', role }));
            console.debug(`[debug] connected as ${role}`);
        });

        socket.addEventListener('message', ({ data }) => {
            try {
                const msg = JSON.parse(data as string);
                if (msg.type === 'ctrl') {
                    if (msg.cmd === 'pause')           _onPause?.();
                    if (msg.cmd === 'resume')          _onResume?.();
                    if (msg.cmd === 'inspector-count') _onInspectorCount?.(msg.n as number);
                    // e2e/debug driving: inject a command, advance N ticks, or rebuild from a scenario.
                    if (msg.cmd === 'command' && msg.command)        _onCommand?.(msg.command as Command);
                    if (msg.cmd === 'step')                          _onStep?.(typeof msg.n === 'number' ? msg.n : 1);
                    if (msg.cmd === 'load-scenario' && msg.scenario) _onLoadScenario?.(msg.scenario as DebugScenario);
                    if (msg.cmd === 'set-label')                     _onLabel?.(typeof msg.text === 'string' ? msg.text : '');
                    // Pathing-incident capture + replay.
                    if (msg.cmd === 'flag')                          _onFlag?.(typeof msg.label === 'string' ? msg.label : '');
                    if (msg.cmd === 'restore' && msg.snapshot)       _onRestore?.(msg.snapshot as WorldSnapshot, msg.map as MapInfo);
                }
            } catch { /* ignore */ }
        });

        socket.addEventListener('error', () => { socket = null; });
        socket.addEventListener('close', () => { socket = null; });
    } catch {
        socket = null;
    }
}

/**
 * Register callbacks so the observer can pause / resume the game simulation.
 * Call this once after role is known.
 */
export function setDebugCallbacks(cbs: {
    onPause?: () => void;
    onResume?: () => void;
    onInspectorCount?: (n: number) => void;
    onCommand?: (cmd: Command) => void;
    onStep?: (n: number) => void;
    onLoadScenario?: (sc: DebugScenario) => void;
    onLabel?: (text: string) => void;
    onFlag?: (label: string) => void;
    onRestore?: (snap: WorldSnapshot, map: MapInfo) => void;
}): void {
    _onPause          = cbs.onPause          ?? null;
    _onResume         = cbs.onResume         ?? null;
    _onInspectorCount = cbs.onInspectorCount ?? null;
    _onCommand        = cbs.onCommand        ?? null;
    _onStep           = cbs.onStep           ?? null;
    _onLoadScenario   = cbs.onLoadScenario   ?? null;
    _onLabel          = cbs.onLabel          ?? null;
    _onFlag           = cbs.onFlag           ?? null;
    _onRestore        = cbs.onRestore        ?? null;
}

/** Ship a flagged incident to the debug server for retroactive analysis. */
export function sendIncident(incident: IncidentCapture): void {
    if (!ready()) return;
    socket!.send(JSON.stringify({ type: 'incident', ...incident }));
}

/** Relay a worker-side error to the server (its stdout is readable; the worker console isn't). Debug aid. */
export function sendDiagError(msg: string): void {
    if (!ready()) return;
    socket!.send(JSON.stringify({ type: 'diag-error', msg }));
}

/** Relay a console line to the debug server so it's readable via the `get_console` tool / `console` query
 *  without opening the in-game overlay. `origin` = "worker" (sim) | "client" (main thread). */
export function sendConsole(origin: string, level: string, msg: string): void {
    if (!ready()) return;
    try { socket!.send(JSON.stringify({ type: 'console', origin, level, msg })); } catch { /* never break logging */ }
}

/** Wire a game box's WORKER console to the in-game overlay (via `post`) AND the debug server, and return
 *  the relay for its MAIN-THREAD console (which main.ts hands back through `setConsoleSink` → a
 *  client-console message → this fn).  Both boxes (host/peer) call this identically — see referee.worker
 *  / client.worker.  (Pairs with `initDebugClient(role)`, which opens the WS this relays over.) */
export function wireBoxConsole(post: (msg: { kind: "worker-console"; level: string; msg: string }) => void): (level: string, msg: string) => void {
    forwardWorkerConsole((level, msg) => { post({ kind: "worker-console", level, msg }); sendConsole("worker", level, msg); });
    return (level, msg) => sendConsole("client", level, msg);
}

// ── Send helpers ──────────────────────────────────────────────────────────────

function ready(): boolean {
    return !!socket && socket.readyState === WebSocket.OPEN;
}

/** Full ECS state snapshot — sent after every game.step(). */
export function sendDebugState(world: SimWorld, hash: number, role: string): void {
    if (!ready()) return;

    const eids  = unitEids(world);
    const units = eids.map(eid => {
        const [hwPx, hhPx] = unitBoxHalfPx(Unit.type[eid]);
        return {
        eid,
        uid:        UnitId.id[eid],
        team:       Unit.team[eid],
        type:       Unit.type[eid],
        px:         Position.x[eid],
        py:         Position.y[eid],
        hw:         hwPx,
        hh:         hhPx,
        curTx:      Path.curTx[eid],
        curTy:      Path.curTy[eid],
        goalTx:     Path.goalTx[eid],
        goalTy:     Path.goalTy[eid],
        stuckTicks: Path.stuckTicks[eid],
        pathActive: Path.active[eid],
        moveActive: MoveTarget.active[eid],
        dir:        UnitAnim.dir[eid],
        moving:     UnitAnim.moving[eid],
        // Queue state for the inspector/MCP (undefined fields are dropped by JSON): a building's
        // production countdown, a unit's pending action-queue length, and a building's rally point.
        prod:       world.production?.[UnitId.id[eid]],
        orders:     world.orders?.[UnitId.id[eid]]?.length || undefined,
        rally:      world.rally?.[UnitId.id[eid]],
        };
    });

    // Active gather blocks (converge moves), per team, as tile coords — lets the inspector
    // overlay the target block and spot unfilled slots (holes).
    const gather: Record<number, Array<[number, number]>> = {};
    for (const [team, slots] of Object.entries(world.gatherSlots ?? {})) {
        gather[Number(team)] = slots.map(([cx, cy]) => [fpToTile(cx), fpToTile(cy)]);
    }

    // Real walk-grid reservations in the bounding region of all units (8px cells) — so the
    // inspector can compare actual reservations vs unit footprints and spot phantom cells.
    let reserved: Array<[number, number, number]> = [];
    if (units.length) {
        let minCx = Infinity, minCy = Infinity, maxCx = -Infinity, maxCy = -Infinity;
        for (const u of units) {
            minCx = Math.min(minCx, Math.floor((u.px - u.hw * 1000) / 8000));
            maxCx = Math.max(maxCx, Math.floor((u.px + u.hw * 1000) / 8000));
            minCy = Math.min(minCy, Math.floor((u.py - u.hh * 1000) / 8000));
            maxCy = Math.max(maxCy, Math.floor((u.py + u.hh * 1000) / 8000));
        }
        reserved = debugReservedRegion(minCx - 3, minCy - 3, maxCx + 3, maxCy + 3);
    }

    socket!.send(JSON.stringify({ type: 'state', role, tick: world.tick, hash, units, gatherSlots: gather, reserved }));
}

/**
 * Command log entry — sent alongside each state update so the observer can
 * reconstruct "what happened" at any tick for deterministic replay.
 */
export function sendDebugCommands(role: string, tick: number, cmds: Command[]): void {
    if (!ready() || !cmds.length) return;
    socket!.send(JSON.stringify({ type: 'cmds', role, tick, commands: cmds }));
}
