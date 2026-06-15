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
 *   trace          → { uid|uids, from?, to? }  tile-change segments of a unit's trajectory
 *   summarize      → { tick? }  auto-analysis of a MOVE (outcomes + stacks; default: last move)
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

        // Compress a unit's host trajectory to tile-change segments over [from,to] (default: since
        // the last command).  One round-trip replaces a fan of get_unit calls.  Each segment:
        // { start, end, tx, ty, goal:[gx,gy]|null, maxStuck, active }.
        case 'trace': {
            const uids = params.uids ?? (params.uid != null ? [params.uid] : []);
            const from = params.from ?? (cmdHistory.length ? cmdHistory[cmdHistory.length - 1].tick : 0);
            const to   = params.to   ?? latestTick;
            const units = {};
            for (const uid of uids) {
                const segs = [];
                let cur = null;
                for (let t = from; t <= to; t++) {
                    const u = stateHistory.get(t)?.host?.units?.find(x => x.uid === uid);
                    if (!u) continue;
                    const active = !!u.moveActive;
                    if (!cur || cur.tx !== u.curTx || cur.ty !== u.curTy || cur.active !== active) {
                        cur = { start: t, end: t, tx: u.curTx, ty: u.curTy, active,
                                goal: u.pathActive ? [u.goalTx, u.goalTy] : null, maxStuck: u.stuckTicks ?? 0 };
                        segs.push(cur);
                    } else {
                        cur.end = t;
                        cur.maxStuck = Math.max(cur.maxStuck, u.stuckTicks ?? 0);
                        if (u.pathActive) cur.goal = [u.goalTx, u.goalTy];
                    }
                }
                units[uid] = segs;
            }
            return { from, to, units };
        }

        // Auto-analyse a MOVE: for each involved unit, start→assigned-goal→settle, whether it reached
        // its goal, max stall, whether it backed off (rubber-band), and group-level stack detection.
        // Defaults to the last MOVE command; pass { tick } to pick a specific one.
        case 'summarize': {
            const moves = cmdHistory.filter(c => c.commands?.some(x => x.type === 1)
                && (params.tick == null || c.tick === params.tick));
            const cmd = moves[moves.length - 1];
            if (!cmd) return { error: 'no MOVE command in history' };
            const mv = cmd.commands.find(x => x.type === 1);
            const T  = cmd.tick;
            const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
            const units = [];
            for (const uid of mv.unitIds) {
                let start = null, goal = null, settle = null, settleTick = null, maxStuck = 0, minDist = Infinity, last = null, wasActive = false;
                for (let t = T; t <= latestTick; t++) {
                    const u = stateHistory.get(t)?.host?.units?.find(x => x.uid === uid);
                    if (!u) continue;
                    if (!start) start = [u.curTx, u.curTy];
                    if (u.pathActive) goal = [u.goalTx, u.goalTy];
                    maxStuck = Math.max(maxStuck, u.stuckTicks ?? 0);
                    if (goal) minDist = Math.min(minDist, cheb(u.curTx, u.curTy, goal[0], goal[1]));
                    last = [u.curTx, u.curTy];
                    if (u.moveActive) wasActive = true;
                    // Stop at THIS move's settle — don't follow the unit into a later command's goal.
                    if (wasActive && !u.moveActive) { settle = [u.curTx, u.curTy]; settleTick = t; break; }
                }
                settle = settle ?? last;
                const finalDist = goal && settle ? cheb(settle[0], settle[1], goal[0], goal[1]) : null;
                units.push({ uid, start, goal, settle, settleTick,
                    reached: !!(goal && settle && finalDist === 0),
                    finalDist, maxStuck,
                    backedOff: finalDist != null && minDist !== Infinity && finalDist > minDist });
            }
            const byTile = {};
            for (const u of units) { const k = (u.settle ?? []).join(','); (byTile[k] ??= []).push(u.uid); }
            return {
                cmdTick: T,
                target: [Math.floor(mv.txFP / 32000), Math.floor(mv.tyFP / 32000)],
                units,
                reached: units.filter(u => u.reached).length,
                stacks: Object.entries(byTile).filter(([, us]) => us.length > 1).map(([tile, uids]) => ({ tile, uids })),
                rubberbanded: units.filter(u => u.backedOff).map(u => u.uid),
            };
        }

        case 'region': {
            // Units within a tile box around (tx,ty), with pairwise DIAMOND clearances — one call
            // instead of get_map (whole map) + N×get_unit.  clear = L1(centres) − (rA+rB); <0 = overlap.
            const tick = params.tick ?? latestTick;
            const slot = stateHistory.get(tick) ?? {};
            const all  = slot.host?.units ?? [];
            const { tx, ty } = params;
            const rad  = params.r ?? 4;
            const team = params.team;
            const inBox = all.filter(u =>
                (team == null || u.team === team)
                && Math.abs(u.curTx - tx) <= rad && Math.abs(u.curTy - ty) <= rad);
            const pairs = [];
            for (let i = 0; i < inBox.length; i++) for (let j = i + 1; j < inBox.length; j++) {
                const a = inBox[i], b = inBox[j];
                const l1  = Math.round((Math.abs(a.px - b.px) + Math.abs(a.py - b.py)) / 1000);
                const sum = (a.hw ?? 16) + (b.hw ?? 16);                // diamond L1 radius = box/2 = hw
                pairs.push({ a: a.uid, b: b.uid, l1, clear: l1 - sum });
            }
            pairs.sort((p, q) => p.clear - q.clear);                    // tightest / overlapping first
            return { tick, center: [tx, ty], radius: rad, units: inBox, pairs };
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
