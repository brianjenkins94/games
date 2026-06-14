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

import { Position, Unit, UnitId, Path, MoveTarget, UnitAnim } from '../game/components';
import type { SimWorld } from '../game/world';
import { unitEids } from '../game/world';
import type { Command } from '../net/protocol';

// Runs in the sim worker (WebSocket works there; the sim state it serialises now
// lives there too).  The only DOM concern — the inspector badge — is delegated to
// the main thread via the onInspectorCount callback, so this module stays
// worker-safe (no `document`).

const DEBUG_WS_URL = 'ws://localhost:9229';

let socket: WebSocket | null = null;
let _onPause:  (() => void) | null = null;
let _onResume: (() => void) | null = null;
let _onInspectorCount: ((n: number) => void) | null = null;

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
}): void {
    _onPause          = cbs.onPause          ?? null;
    _onResume         = cbs.onResume         ?? null;
    _onInspectorCount = cbs.onInspectorCount ?? null;
}

// ── Send helpers ──────────────────────────────────────────────────────────────

function ready(): boolean {
    return !!socket && socket.readyState === WebSocket.OPEN;
}

/** Full ECS state snapshot — sent after every game.step(). */
export function sendDebugState(world: SimWorld, hash: number, role: string): void {
    if (!ready()) return;

    const eids  = unitEids(world);
    const units = eids.map(eid => ({
        eid,
        uid:        UnitId.id[eid],
        team:       Unit.team[eid],
        px:         Position.x[eid],
        py:         Position.y[eid],
        curTx:      Path.curTx[eid],
        curTy:      Path.curTy[eid],
        goalTx:     Path.goalTx[eid],
        goalTy:     Path.goalTy[eid],
        pathActive: Path.active[eid],
        moveActive: MoveTarget.active[eid],
        dir:        UnitAnim.dir[eid],
        moving:     UnitAnim.moving[eid],
    }));

    socket!.send(JSON.stringify({ type: 'state', role, tick: world.tick, hash, units }));
}

/**
 * Command log entry — sent alongside each state update so the observer can
 * reconstruct "what happened" at any tick for deterministic replay.
 */
export function sendDebugCommands(role: string, tick: number, cmds: Command[]): void {
    if (!ready() || !cmds.length) return;
    socket!.send(JSON.stringify({ type: 'cmds', role, tick, commands: cmds }));
}
