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

const DEBUG_WS_URL = 'ws://localhost:9229';

let socket: WebSocket | null = null;
let _onPause:  (() => void) | null = null;
let _onResume: (() => void) | null = null;

// ── Inspector badge ───────────────────────────────────────────────────────────

function updateInspectorBadge(n: number): void {
    const ID = 'claude-inspector-badge';
    let badge = document.getElementById(ID);
    if (n > 0) {
        if (!badge) {
            badge = document.createElement('div');
            badge.id = ID;
            badge.style.cssText = [
                'position:fixed', 'top:8px', 'right:8px',
                'background:#6d28d9', 'color:#fff',
                'font:bold 11px/1 monospace', 'padding:4px 8px',
                'border-radius:4px', 'z-index:9999', 'pointer-events:none',
                'letter-spacing:0.05em',
            ].join(';');
            document.body.appendChild(badge);
        }
        badge.textContent = `🤖 Claude (${n})`;
    } else {
        badge?.remove();
    }
}

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
                    if (msg.cmd === 'inspector-count') updateInspectorBadge(msg.n as number);
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
export function setDebugCallbacks(cbs: { onPause?: () => void; onResume?: () => void }): void {
    _onPause  = cbs.onPause  ?? null;
    _onResume = cbs.onResume ?? null;
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
