/**
 * Debug WebSocket server — port 9229.
 *
 * Roles:
 *   "host" / "peer"   — game instances (browser)
 *   "inspector"       — MCP server (tools/mcp-inspector.mjs)
 *
 * Protocol (all JSON):
 *   game → server      { type:"state",  role, tick, hash, units:[...] }
 *   game → server      { type:"cmds",   role, tick, commands:[...] }
 *   inspector → server { type:"hello",  role:"inspector" }
 *   inspector → server { type:"query",  id, query, ...params }
 *   inspector → server { type:"ctrl",   cmd:"pause"|"resume" }
 *   server → inspector { type:"hello-ack", minTick, maxTick, tickCount }
 *   server → inspector { type:"query-result", id, result }
 *   server → inspector { type:"query-error",  id, message }
 *   server → game      { type:"ctrl",   cmd:"pause"|"resume"|"inspector-count", n? }
 *
 * Supported queries:
 *   status         → connection/tick summary
 *   state          → { tick? }  full unit state at tick (default: latest)
 *   unit           → { uid, tick? }  single unit on host + peer
 *   diff           → { tick? }  host vs peer field diff
 *   commands       → { from?, to? }  command log slice
 *   divergence     → { from?, to? }  first tick where hashes differ
 *   history_range  → min/max/count of stored ticks
 */

import { WebSocketServer, WebSocket } from 'ws';
import { computeDiff } from './diff.mjs';

const PORT = 9229;
const wss  = new WebSocketServer({ port: PORT });

/** role → Set<WebSocket> */
const clients = new Map();

/**
 * tick → { host?: stateBlob, peer?: stateBlob }
 * No eviction cap — dev sessions are short enough that memory isn't a concern.
 */
const stateHistory = new Map();

/** [{ tick, role, commands }] */
const cmdHistory = [];

let latestTick = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function broadcast(role, payload) {
    for (const ws of clients.get(role) ?? []) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
}

function broadcastGames(payload) {
    broadcast('host', payload);
    broadcast('peer', payload);
}

function inspectorCount() {
    return clients.get('inspector')?.size ?? 0;
}

function notifyInspectorCount() {
    broadcastGames(JSON.stringify({ type: 'ctrl', cmd: 'inspector-count', n: inspectorCount() }));
}

function recordState(role, msg) {
    // Game reloaded → its tick counter restarts low.  Drop the stale session's history so
    // "latest" doesn't keep pointing at the old game's final frame.
    if (msg.tick < latestTick - 1) {
        stateHistory.clear();
        cmdHistory.length = 0;
        latestTick = 0;
        console.log(`[debug] tick reset (${msg.tick}) — cleared stale session history`);
    }
    if (!stateHistory.has(msg.tick)) stateHistory.set(msg.tick, {});
    stateHistory.get(msg.tick)[role] = msg;
    if (msg.tick > latestTick) latestTick = msg.tick;
}

// ── Query handlers ────────────────────────────────────────────────────────────

function runQuery(query, params) {
    switch (query) {
        case 'status': {
            const ticks = [...stateHistory.keys()];
            return {
                connected:  { host: !!clients.get('host')?.size, peer: !!clients.get('peer')?.size },
                latestTick,
                tickCount:  stateHistory.size,
                minTick:    ticks[0]              ?? null,
                maxTick:    ticks[ticks.length-1] ?? null,
                inspectors: inspectorCount(),
            };
        }

        case 'state': {
            const tick = params.tick ?? latestTick;
            const slot = stateHistory.get(tick) ?? {};
            return {
                tick,
                hashMatch: slot.host && slot.peer ? slot.host.hash === slot.peer.hash : null,
                host: slot.host ?? null,
                peer: slot.peer ?? null,
            };
        }

        case 'unit': {
            const tick = params.tick ?? latestTick;
            const slot = stateHistory.get(tick) ?? {};
            return {
                tick,
                uid:  params.uid,
                host: slot.host?.units?.find(u => u.uid === params.uid) ?? null,
                peer: slot.peer?.units?.find(u => u.uid === params.uid) ?? null,
            };
        }

        case 'diff': {
            const tick = params.tick ?? latestTick;
            const slot = stateHistory.get(tick);
            if (!slot?.host || !slot?.peer) return { tick, available: false };
            return {
                tick,
                hashMatch: slot.host.hash === slot.peer.hash,
                hostHash:  slot.host.hash,
                peerHash:  slot.peer.hash,
                diffs:     computeDiff(slot.host, slot.peer),
            };
        }

        case 'commands': {
            const from = params.from ?? 0;
            const to   = params.to   ?? latestTick;
            return { from, to, commands: cmdHistory.filter(c => c.tick >= from && c.tick <= to) };
        }

        case 'divergence': {
            const from = params.from ?? 0;
            const to   = params.to   ?? latestTick;
            for (const [tick, slot] of stateHistory) {
                if (tick < from || tick > to) continue;
                if (!slot.host || !slot.peer)  continue;
                if (slot.host.hash !== slot.peer.hash) {
                    return {
                        divergedAt: tick,
                        hostHash:   slot.host.hash,
                        peerHash:   slot.peer.hash,
                        diffs:      computeDiff(slot.host, slot.peer),
                    };
                }
            }
            return { divergedAt: null };
        }

        case 'history_range': {
            const ticks = [...stateHistory.keys()];
            return {
                minTick:   ticks[0]              ?? null,
                maxTick:   ticks[ticks.length-1] ?? null,
                tickCount: ticks.length,
            };
        }

        default:
            throw new Error(`unknown query: ${query}`);
    }
}

function handleQuery(ws, msg) {
    try {
        const result = runQuery(msg.query, msg);
        ws.send(JSON.stringify({ type: 'query-result', id: msg.id, result }));
    } catch (e) {
        ws.send(JSON.stringify({ type: 'query-error', id: msg.id, message: e.message }));
    }
}

// ── Connection handler ────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
    let role = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'hello') {
            role = msg.role;
            if (!clients.has(role)) clients.set(role, new Set());
            clients.get(role).add(ws);
            console.log(`[debug] +${role}`);

            if (role === 'inspector') {
                notifyInspectorCount();
                const ticks = [...stateHistory.keys()];
                ws.send(JSON.stringify({
                    type:      'hello-ack',
                    minTick:   ticks[0]              ?? null,
                    maxTick:   ticks[ticks.length-1] ?? null,
                    tickCount: ticks.length,
                }));
            }
            return;
        }

        if (msg.type === 'state' && (role === 'host' || role === 'peer')) {
            recordState(role, msg);
            return;
        }

        if (msg.type === 'cmds' && (role === 'host' || role === 'peer')) {
            cmdHistory.push({ tick: msg.tick, role, commands: msg.commands });
            return;
        }

        if (msg.type === 'query' && role === 'inspector') {
            handleQuery(ws, msg);
            return;
        }

        if (msg.type === 'ctrl' && role === 'inspector') {
            broadcastGames(JSON.stringify(msg));
            console.log(`[debug] ctrl:${msg.cmd} ← inspector`);
            return;
        }
    });

    ws.on('close', () => {
        if (!role) return;
        clients.get(role)?.delete(ws);
        console.log(`[debug] -${role}`);
        if (role === 'inspector') notifyInspectorCount();
    });

    ws.on('error', () => {});
});

console.log(`[debug] ws://localhost:${PORT}`);
