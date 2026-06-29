/**
 * Debug server — single process on port 9229: HTTP (MCP for Claude Code at POST /mcp) + WebSocket.
 *
 * WS roles:
 *   "host" / "peer"   — game instances (browser)
 *   "inspector"       — WS query/ctrl clients (e.g. the Playwright e2e harness)
 *   "metrics"         — host page's perf bridge (src/debug/metricsForward.ts)
 *
 * The MCP tools (formerly the separate stdio tools/mcp-inspector.mjs) are now served in-process over
 * HTTP and call runQuery() directly — Claude connects via games/.mcp.json ({ type:"http", url:.../mcp }).
 *
 * Protocol (all JSON):
 *   game → server      { type:"state",  role, tick, hash, units:[...] }
 *   game → server      { type:"cmds",   role, tick, commands:[...] }
 *   metrics → server   { type:"metrics", role:"host"|"peer", t, fields:{...} }
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
 *   metrics        → per-box perf: snapshot (latest + windowed summary) or a selected
 *                    slice { last?, sinceMs?, from?, to?, fields?, raw?, aggregate? }
 *   state          → { tick? }  full unit state at tick (default: latest)
 *   unit           → { uid, tick? }  single unit on host + peer
 *   diff           → { tick? }  host vs peer field diff
 *   commands       → { from?, to? }  command log slice
 *   divergence     → { from?, to? }  first tick where hashes differ
 *   history_range  → min/max/count of stored ticks
 *   trace          → { uid|uids, from?, to? }  tile-change segments of a unit's trajectory
 *   summarize      → { tick? }  auto-analysis of a MOVE (outcomes + stacks; default: last move)
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { computeDiff } from './diff.mjs';

const PORT = 9229;
// One process, one port: an HTTP server (MCP for Claude Code at POST /mcp) with the WebSocket server
// attached to it (games, metrics, and WS "inspector" clients like the Playwright test). The old stdio
// proxy (mcp-inspector.mjs) is gone — the MCP tools call runQuery() in-process below. Claude connects
// over HTTP; see games/.mcp.json ({ type:"http", url:"http://localhost:9229/mcp" }).
const httpServer = createServer(handleHttp);
const wss = new WebSocketServer({ server: httpServer });

/** role → Set<WebSocket> */
const clients = new Map();

/**
 * tick → { host?: stateBlob, peer?: stateBlob }
 * No eviction cap — dev sessions are short enough that memory isn't a concern.
 */
const stateHistory = new Map();

/** [{ tick, role, commands }] */
const cmdHistory = [];

/** Captured pathing incidents (flagged in-game or via the flag_incident tool), newest last, capped.
 *  Each: { id, flagTick, baseTick, label, snapshot, map, commands, createdAt }. */
const incidents = [];
let incidentSeq = 0;
const INCIDENTS_MAX = 50;

/** Recent console output per game box (host/peer), relayed from each box's main thread + sim worker —
 *  so a fresh inspector can read what each game printed (via get_console) without the in-game overlay. */
const consoleHistory = { host: [], peer: [] };
const CONSOLE_MAX = 400;
const INCIDENT_TEST_DIR = fileURLToPath(new URL('../test/incidents/', import.meta.url));

/** Promote a captured incident to a permanent regression fixture (test/incidents/<id>.json). The focus
 *  unit + goal come from the last MOVE in the window; the runner (test/pathing.incidents.test.ts) globs
 *  these, replays each deterministically, and asserts the outcome. Returns { path, focus } or { error }. */
function saveIncidentTest(id) {
    const inc = incidents.find(i => i.id === id);
    if (!inc) return { error: `no incident: ${id}` };
    const lastMove = inc.commands.flatMap(c => c.commands).reverse().find(x => x.type === 1);   // CmdType.MOVE
    const focus = lastMove ? { uid: lastMove.unitIds?.[0], goal: [Math.floor(lastMove.txFP / 32000), Math.floor(lastMove.tyFP / 32000)] } : null;
    const fixture = {
        id: inc.id, label: inc.label, baseTick: inc.baseTick, flagTick: inc.flagTick, expectHash: inc.flagHash,
        map: inc.map, snapshot: inc.snapshot, commands: inc.commands, focus,
        // Default expectation: the focus unit reaches its goal. REVIEW before relying on it — a
        // legitimately-unreachable give-up isn't a bug (delete the fixture or change `expect`).
        expect: { reachesGoal: !!focus, settleBudget: 600 },
    };
    mkdirSync(INCIDENT_TEST_DIR, { recursive: true });
    const path = INCIDENT_TEST_DIR + `${inc.id}.json`;
    writeFileSync(path, JSON.stringify(fixture, null, 1));
    console.log(`[debug] wrote regression fixture ${path}`);
    return { path, focus, expect: fixture.expect };
}

/** game-role ("host"/"peer") → [{ t, fields }, …] ring buffer of perf samples, pushed by
 *  the host page's metrics bridge (src/debug/metricsForward.ts) at ~4 Hz.  Trimmed to
 *  METRICS_CAP and cleared on session reset, so it holds the current game's recent history. */
const metricsHistory = {};
const METRICS_CAP = 600;             // ~150 s per box at 4 Hz
const METRICS_WINDOW_MS = 30_000;    // default snapshot window (matches the on-page charts)
/** The current metrics-bridge socket.  A fresh bridge `hello` means the host page was
 *  (re)loaded → new session: we drop prior perf history and ignore any lingering older
 *  bridge, so get_metrics only ever reflects the most-recently-loaded page (see hello). */
let metricsWs = null;

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
        for (const role of Object.keys(metricsHistory)) delete metricsHistory[role];
        latestTick = 0;
        console.log(`[debug] tick reset (${msg.tick}) — cleared stale session history`);
    }
    if (!stateHistory.has(msg.tick)) stateHistory.set(msg.tick, {});
    stateHistory.get(msg.tick)[role] = msg;
    if (msg.tick > latestTick) latestTick = msg.tick;
}

/** Keep only `names` (if given) from a flat fields bag. */
function pickFields(fields, names) {
    if (!names) return fields;
    const out = {};
    for (const n of names) if (n in fields) out[n] = fields[n];
    return out;
}

/** Per-field {last,min,max,avg,p95,n} over a set of samples — compresses a noisy window
 *  (tickMs, per-sample bytes) into something a single read can reason about. */
function summarizeMetrics(samples, names) {
    const fieldNames = names ?? [...new Set(samples.flatMap(s => Object.keys(s.fields)))];
    const out = {};
    for (const name of fieldNames) {
        const vals = samples.map(s => s.fields[name]).filter(v => typeof v === 'number');
        if (!vals.length) continue;
        const sorted = [...vals].sort((a, b) => a - b);
        const sum = vals.reduce((a, b) => a + b, 0);
        out[name] = {
            last: vals[vals.length - 1],
            min:  sorted[0],
            max:  sorted[sorted.length - 1],
            avg:  Math.round((sum / vals.length) * 100) / 100,
            p95:  sorted[Math.floor(0.95 * (sorted.length - 1))],
            n:    vals.length,
        };
    }
    return out;
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
                // per box: how many perf samples are buffered (history available to get_metrics)
                metrics:    Object.fromEntries(Object.entries(metricsHistory).map(([r, a]) => [r, a.length])),
            };
        }

        // Realtime perf per box (host/peer).  Default (no params): a snapshot — the latest
        // sample + a summary over the last METRICS_WINDOW_MS.  Selection params return an
        // arbitrary slice of history; `raw`/`aggregate` and `fields` shape the output.
        //   last:N        last N samples           sinceMs:X   samples within the last X ms
        //   from,to       absolute ms range        fields:[…]  restrict to these field names
        //   raw:true      include raw samples      aggregate:true  summary only (no raw)
        // bytesIn/bytesOut are bytes-per-sample (~250ms); tickMs is vs the ~50ms sim budget;
        // rtt/lead are guest-only (host plays in-process → 0).
        case 'metrics': {
            const now = Date.now();
            const names = Array.isArray(params.fields) && params.fields.length ? params.fields : null;
            const hasSel = params.last != null || params.sinceMs != null || params.from != null || params.to != null;
            const includeRaw = params.raw === true || (hasSel && params.aggregate !== true);

            const out = {};
            for (const [role, all] of Object.entries(metricsHistory)) {
                if (!all.length) continue;

                let selected;
                if (params.last != null)         selected = all.slice(-params.last);
                else if (params.sinceMs != null) selected = all.filter(s => s.t >= now - params.sinceMs);
                else if (params.from != null || params.to != null) {
                    const lo = params.from ?? -Infinity, hi = params.to ?? Infinity;
                    selected = all.filter(s => s.t >= lo && s.t <= hi);
                } else {
                    selected = all.filter(s => s.t >= now - METRICS_WINDOW_MS);   // default snapshot window
                }

                const latest = all[all.length - 1];
                const entry = {
                    latest: { t: latest.t, ageMs: now - latest.t, fields: pickFields(latest.fields, names) },
                    window: {
                        n:      selected.length,
                        spanMs: selected.length ? selected[selected.length - 1].t - selected[0].t : 0,
                        summary: summarizeMetrics(selected, names),
                    },
                };
                if (includeRaw) entry.samples = selected.map(s => ({ t: s.t, fields: pickFields(s.fields, names) }));
                out[role] = entry;
            }
            return { now, window: hasSel ? 'selection' : `last ${METRICS_WINDOW_MS / 1000}s`, metrics: out };
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

        case 'console': {
            const last = params.last ?? 80;
            const fmt = (role) => consoleHistory[role].slice(-last).map(e => `${new Date(e.t).toTimeString().slice(0, 8)} [${e.origin}:${e.level}] ${e.msg}`);
            if (params.role === 'host' || params.role === 'peer') return { role: params.role, lines: fmt(params.role) };
            return { host: fmt('host'), peer: fmt('peer') };
        }

        case 'incidents':
            return { incidents: incidents.map(i => ({ id: i.id, baseTick: i.baseTick, flagTick: i.flagTick, label: i.label, commands: i.commands.length, units: i.snapshot?.units?.length ?? 0, ageMs: Date.now() - i.createdAt })) };

        case 'incident': {
            // NB: `incidentId`, not `id` — the inspector query envelope reserves `id` for request tracking.
            const inc = incidents.find(i => i.id === params.incidentId);
            if (!inc) return { error: `no incident: ${params.incidentId}` };
            const units = (inc.snapshot?.units ?? []).map(u => ({ uid: u.uid, type: u.type, team: u.team, tx: Math.floor(u.x / 32000), ty: Math.floor(u.y / 32000), bw: u.bw, bh: u.bh }));
            return { id: inc.id, baseTick: inc.baseTick, flagTick: inc.flagTick, label: inc.label, commands: inc.commands, units };
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

// ── MCP (HTTP) — Claude Code tools, served in-process over runQuery ─────────────
// Folded in from the former tools/mcp-inspector.mjs: same tools + formatters, but calling runQuery()
// directly instead of proxying over WS. Served at POST /mcp via the Streamable HTTP transport.

const DIR = ['N','NE','E','SE','S','SW','W','NW'];
const tcFP = (t) => t * 32 * 1000 + 16 * 1000;   // tile index → tile-centre fixed-point (FP=1000, TILE_PX=32)

function fmtUnit(u) {
    if (!u) return null;
    const px = u.px != null ? u.px / 1000 : null;
    const py = u.py != null ? u.py / 1000 : null;
    const off = px != null ? [Math.round(((px % 32) + 32) % 32 - 16), Math.round(((py % 32) + 32) % 32 - 16)] : null;
    return {
        uid: u.uid, team: u.team, tile: [u.curTx, u.curTy],
        pos: px != null ? [Math.round(px), Math.round(py)] : null,
        offCentre: off, box: u.hw != null ? [u.hw * 2, u.hh * 2] : null,
        goal: u.pathActive ? [u.goalTx, u.goalTy] : null,
        stuck: u.stuckTicks ?? 0, dir: DIR[u.dir] ?? u.dir,
        moving: !!u.moving, pathActive: !!u.pathActive, moveActive: !!u.moveActive,
    };
}

function fmtRegion(raw) {
    if (!raw || !raw.units) return 'no data';
    const lines = [`region @t${raw.tick} centre(${raw.center[0]},${raw.center[1]}) r${raw.radius} — ${raw.units.length} units`];
    for (const u of raw.units) {
        const f = fmtUnit(u);
        const g = f.goal ? ` →goal(${f.goal[0]},${f.goal[1]})` : '';
        const mv = f.moveActive ? `mv dir${f.dir} stuck${f.stuck}` : 'settled';
        lines.push(`  uid${f.uid} tile(${f.tile[0]},${f.tile[1]}) off(${f.offCentre[0]},${f.offCentre[1]}) ${mv}${g}`);
    }
    if (raw.pairs?.length) {
        lines.push('  pairs (L1px / clearance; <0 = overlap):');
        for (const p of raw.pairs) lines.push(`    ${p.a}–${p.b}: ${p.l1}px  clear ${p.clear >= 0 ? '+' : ''}${p.clear}`);
    }
    return lines.join('\n');
}

function fmtState(blob) {
    if (!blob) return null;
    return {
        tick: blob.tick,
        hash: (blob.hash >>> 0).toString(16).padStart(8, '0'),
        units: (blob.units ?? []).map(fmtUnit),
    };
}

function renderMap(blob, teamFilter) {
    if (!blob) return 'no state at that tick';
    const inTeam = (t) => teamFilter == null || t === teamFilter;
    const gather    = blob.gatherSlots ?? {};
    const slotTiles = Object.entries(gather).filter(([t]) => inTeam(Number(t))).flatMap(([, s]) => s);
    const slotSet   = new Set(slotTiles.map(([x, y]) => `${x},${y}`));
    const unitPts   = (blob.units ?? []).filter(u => inTeam(u.team)).map(u => ({ x: u.curTx, y: u.curTy, u }));
    if (!unitPts.length && !slotTiles.length) return '(no units / no gather block at that tick)';
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { x, y } of unitPts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (const [x, y] of slotTiles) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const unitAt     = new Set(unitPts.map(p => `${p.x},${p.y}`));
    const filled     = slotTiles.filter(([x, y]) => unitAt.has(`${x},${y}`)).length;
    const moving     = unitPts.filter(p => p.u.moveActive).length;
    const stragglers = slotSet.size ? unitPts.filter(p => !slotSet.has(`${p.x},${p.y}`)).length : 0;
    return [
        `${unitPts.length} units (moving ${moving}, settled ${unitPts.length - moving}) in tiles [${minX},${minY}]‥[${maxX},${maxY}]`,
        slotTiles.length ? `gather slots: ${slotTiles.length}  filled ${filled}  HOLES ${slotTiles.length - filled}  stragglers ${stragglers}` : 'no active gather block',
    ].join('\n');
}

function renderWalkMap(blob, teamFilter) {
    if (!blob) return 'no state at that tick';
    const CELL = 8;
    const inTeam = (t) => teamFilter == null || t === teamFilter;
    const units = (blob.units ?? []).filter(u => inTeam(u.team) && u.px != null);
    if (!units.length) return '(no units with position data — reload the dev game so it streams px/hw)';
    const footByEid = new Map();
    const footSet = new Set();
    for (const u of (blob.units ?? [])) {
        if (u.px == null) continue;
        const cx = u.px / 1000, cy = u.py / 1000, hw = u.hw ?? 16, hh = u.hh ?? 16;
        const l = Math.floor((cx - hw) / CELL), r = Math.floor((cx + hw - 1) / CELL);
        const tt = Math.floor((cy - hh) / CELL), bb = Math.floor((cy + hh - 1) / CELL);
        const s = new Set();
        for (let y = tt; y <= bb; y++) for (let x = l; x <= r; x++) { s.add(`${x},${y}`); if (inTeam(u.team)) footSet.add(`${x},${y}`); }
        footByEid.set(u.eid, s);
    }
    const reserved = blob.reserved ?? [];
    const resAt = new Map(reserved.map(([cx, cy, owner]) => [`${cx},${cy}`, owner]));
    const uidOf = new Map(blob.units.map(u => [u.eid, u.uid]));
    const phantomCells = [];
    for (const [cx, cy, owner] of reserved) {
        if (!footByEid.get(owner)?.has(`${cx},${cy}`)) phantomCells.push([cx, cy, owner]);
    }
    const footCount = new Map();
    for (const s of footByEid.values()) for (const k of s) footCount.set(k, (footCount.get(k) ?? 0) + 1);
    const overlaps = [...footCount].filter(([, n]) => n > 1).map(([k]) => k);
    const unreserved = [...footSet].filter(k => !resAt.has(k)).length;
    const offOf = (u) => [Math.round(((u.px / 1000 % 32) + 32) % 32 - 16), Math.round(((u.py / 1000 % 32) + 32) % 32 - 16)];
    const offGrid = units.filter(u => { const [ox, oy] = offOf(u); return ox || oy; });
    return [
        `${units.length} units: ${units.length - offGrid.length} grid-aligned, ${offGrid.length} off-centre`,
        ...offGrid.map(u => { const [ox, oy] = offOf(u); return `  uid${u.uid} tile(${u.curTx},${u.curTy}) off(${ox},${oy}) stuck${u.stuckTicks ?? 0} ${u.moveActive ? 'active' : 'settled'}`; }),
        reserved.length ? `reservations ${reserved.length}; PHANTOMS ${phantomCells.length}; overlaps ${overlaps.length}; footprint-unreserved ${unreserved}` : 'no reservation data (reload dev game)',
        ...phantomCells.slice(0, 24).map(([cx, cy, o]) => `  PHANTOM cell(${cx},${cy}) owner uid${uidOf.get(o) ?? '?'}`),
        ...overlaps.slice(0, 12).map(k => `  OVERLAP cell(${k})`),
    ].join('\n');
}

function fmtTrace(res) {
    const lines = [];
    for (const [uid, segs] of Object.entries(res.units ?? {})) {
        if (!segs.length) { lines.push(`uid${uid}: (no data in ${res.from}–${res.to})`); continue; }
        lines.push(`uid${uid} (t${res.from}–${res.to}):`);
        for (const s of segs) {
            const span  = s.start === s.end ? `t${s.start}` : `t${s.start}–${s.end}`;
            const dwell = s.end - s.start + 1;
            const goal  = s.goal ? ` →(${s.goal[0]},${s.goal[1]})` : '';
            const stall = s.maxStuck ? ` stuck≤${s.maxStuck}` : '';
            const flag  = !s.active ? ' SETTLED' : dwell >= 20 ? `  [dwell ${dwell}t]` : '';
            lines.push(`  ${span} (${s.tx},${s.ty})${goal}${stall}${flag}`);
        }
    }
    return lines.join('\n') || '(no units traced)';
}

function fmtSummary(res) {
    if (res.error) return res.error;
    const lines = [`move @t${res.cmdTick} → target(${res.target[0]},${res.target[1]}), ${res.units.length} units, ${res.reached} reached goal:`];
    for (const u of res.units) {
        const start  = u.start  ? `(${u.start[0]},${u.start[1]})` : '(?)';
        const goal   = u.goal   ? `(${u.goal[0]},${u.goal[1]})`   : '(none)';
        const settle = u.settle ? `(${u.settle[0]},${u.settle[1]})` : '(?)';
        const at     = u.settleTick ? `@t${u.settleTick}` : 'still moving';
        const verdict = u.reached ? '✓reached' : `✗short(${u.finalDist})`;
        const extra  = `${u.backedOff ? ' RUBBER-BAND' : ''}${u.maxStuck ? ` maxStuck${u.maxStuck}` : ''}`;
        lines.push(`  uid${u.uid} ${start}→goal${goal}  settled ${settle} ${at} ${verdict}${extra}`);
    }
    if (res.stacks.length) lines.push(`STACKS: ${res.stacks.map(s => `(${s.tile}){${s.uids.map(u => 'uid' + u).join(',')}}`).join('  ')}`);
    if (res.rubberbanded.length) lines.push(`rubber-banded: ${res.rubberbanded.map(u => 'uid' + u).join(', ')}`);
    return lines.join('\n');
}

const TOOLS = [
    { name: 'get_status', description: 'Check whether host/peer are connected, the current tick, and how much history is available.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_metrics', description: 'Realtime perf per box (host/peer): fps, frame time (ms), sim tick duration (tickMs, vs the ~50ms budget), rtt/lead (guest only — host plays in-process so both read 0), entity count, and wire bytesIn/bytesOut per ~250ms sample. Samples are buffered ~4 Hz (up to ~150s, cleared on game reload). Called with no args it returns a SNAPSHOT: each box\'s latest sample (with ageMs) plus a summary (last/min/max/avg/p95) over the last 30s. Pass selection params for an arbitrary slice of history.', inputSchema: { type: 'object', properties: { last: { type: 'number', description: 'Return the last N samples per box (raw series)' }, sinceMs: { type: 'number', description: 'Samples within the last X milliseconds' }, from: { type: 'number', description: 'Absolute start time (ms epoch, matches sample.t)' }, to: { type: 'number', description: 'Absolute end time (ms epoch)' }, fields: { type: 'array', items: { type: 'string' }, description: 'Restrict to these field names (e.g. ["fps","tickMs"])' }, raw: { type: 'boolean', description: 'Include raw samples even in snapshot mode' }, aggregate: { type: 'boolean', description: 'With a selection, return only the summary (omit raw samples)' } } } },
    { name: 'get_state', description: 'Get full game state (all units, hash) for host and peer at a tick. Omit tick for latest.', inputSchema: { type: 'object', properties: { tick: { type: 'number', description: 'Tick to inspect (omit = latest)' } } } },
    { name: 'get_map', description: 'Compact spatial diagnostic of units (host) at a tick: unit counts + tile bbox, per-unit off-centre offsets, and lists of phantom/overlap/hole cells. Pass fine=true for the 8px walk grid (reservations + sub-tile offsets) vs the default 32px tile summary.', inputSchema: { type: 'object', properties: { tick: { type: 'number', description: 'Tick to inspect (omit = latest)' }, team: { type: 'number', description: 'Only show this team (omit = all)' }, fine: { type: 'boolean', description: 'Use the 8px walk grid (reservations, sub-tile) instead of 32px tiles' } } } },
    { name: 'get_unit', description: 'Get one unit\'s state on both host and peer at a tick.', inputSchema: { type: 'object', properties: { uid: { type: 'number', description: 'Unit ID' }, tick: { type: 'number', description: 'Tick to inspect (omit = latest)' } }, required: ['uid'] } },
    { name: 'get_region', description: 'Units within a tile box around (tx,ty), plus pairwise DIAMOND clearances (L1 centre distance minus summed radii; negative = overlap, tightest listed first).', inputSchema: { type: 'object', properties: { tx: { type: 'number', description: 'Centre tile X' }, ty: { type: 'number', description: 'Centre tile Y' }, r: { type: 'number', description: 'Box radius in tiles (default 4)' }, team: { type: 'number', description: 'Only this team (omit = all)' }, tick: { type: 'number', description: 'Tick to inspect (omit = latest)' } }, required: ['tx', 'ty'] } },
    { name: 'trace_unit', description: 'Compact trajectory of one or more units (host) over a tick range, compressed to tile-change segments with dwell time and max stall. Defaults to since the last command → latest.', inputSchema: { type: 'object', properties: { uids: { type: 'array', items: { type: 'number' }, description: 'Unit IDs to trace (or use uid)' }, uid: { type: 'number', description: 'Single unit ID (shorthand for uids:[uid])' }, from: { type: 'number', description: 'Start tick (omit = last command tick)' }, to: { type: 'number', description: 'End tick (omit = latest)' } } } },
    { name: 'summarize_move', description: 'Auto-analyse a MOVE command: per-unit start→assigned-goal→settle tile, whether each reached its goal or settled short, max stall, rubber-band, and group-level stack detection. Defaults to the last MOVE; pass tick to pick one.', inputSchema: { type: 'object', properties: { tick: { type: 'number', description: 'Command tick to summarize (omit = last MOVE)' } } } },
    { name: 'get_diff', description: 'Compare host vs peer at a tick — shows per-unit field divergences and whether hashes match.', inputSchema: { type: 'object', properties: { tick: { type: 'number', description: 'Tick to diff (omit = latest)' } } } },
    { name: 'list_commands', description: 'Show commands applied in a tick range (both roles).', inputSchema: { type: 'object', properties: { from: { type: 'number', description: 'Start tick (inclusive)' }, to: { type: 'number', description: 'End tick (inclusive)' } } } },
    { name: 'find_divergence', description: 'Scan a tick range and return the first tick where host and peer hashes diverge, plus the diff at that tick.', inputSchema: { type: 'object', properties: { from: { type: 'number', description: 'Start tick (inclusive, omit = beginning of history)' }, to: { type: 'number', description: 'End tick (inclusive, omit = latest)' } } } },
    { name: 'get_history_range', description: 'Get the min and max tick stored in the debug server.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_console', description: "Recent console output from each game box (host/peer) — what the game printed, including its sim WORKER (tagged origin worker|client). This is the cheap way to read a game's logs/errors; the browser console (preview_console_logs) only sees the top page, not the box iframes/workers.", inputSchema: { type: 'object', properties: { role: { type: 'string', description: "Only this box: 'host' or 'peer' (omit = both)" }, last: { type: 'number', description: 'Lines per box (default 80)' } } } },
    { name: 'pause', description: 'Pause the game simulation on both host and peer.', inputSchema: { type: 'object', properties: {} } },
    { name: 'resume', description: 'Resume the game simulation on both host and peer.', inputSchema: { type: 'object', properties: {} } },
    // ── e2e/debug driving (host referee) ──
    { name: 'move_units', description: 'Issue a MOVE command to the host sim: send the given unit ids toward tile (tx,ty). Applied immediately on the referee.', inputSchema: { type: 'object', properties: { uids: { type: 'array', items: { type: 'number' }, description: 'Unit ids to move' }, tx: { type: 'number', description: 'Target tile X' }, ty: { type: 'number', description: 'Target tile Y' } }, required: ['uids', 'tx', 'ty'] } },
    { name: 'stop_units', description: 'Issue a STOP command to the host sim for the given unit ids.', inputSchema: { type: 'object', properties: { uids: { type: 'array', items: { type: 'number' }, description: 'Unit ids to stop' } }, required: ['uids'] } },
    { name: 'spawn_unit', description: 'Spawn a unit on the host sim at tile (tx,ty) for a team. typeId is the interned unit-type id (default 0).', inputSchema: { type: 'object', properties: { team: { type: 'number', description: 'Team (0 or 1)' }, tx: { type: 'number', description: 'Tile X' }, ty: { type: 'number', description: 'Tile Y' }, typeId: { type: 'number', description: 'Interned unit-type id (default 0)' } }, required: ['team', 'tx', 'ty'] } },
    { name: 'step', description: 'Advance the host sim exactly N ticks (load a scenario or pause first; the harness loads paused, then steps).', inputSchema: { type: 'object', properties: { n: { type: 'number', description: 'Number of ticks to advance (default 1)' } } } },
    { name: 'load_scenario', description: 'Rebuild the host sim from a tiny scenario (fresh map + explicit unit placements), left paused. scenario = { seed?, mapInfo:{gids,mapW,mapH,terrainArr}, spawns:[{team,tx,ty,typeId?}], buildings?:[{team,tx,ty,typeId}] }. Buildings spawn FINISHED (ready to produce). Mainly used by the e2e harness; clears all prior state.', inputSchema: { type: 'object', properties: { scenario: { type: 'object', description: 'The scenario object (see description)' } }, required: ['scenario'] } },
    { name: 'build', description: 'Issue a BUILD command: place a building of typeId at footprint top-left tile (tx,ty) for a team. Starts as a construction site (use load_scenario buildings for a finished one).', inputSchema: { type: 'object', properties: { typeId: { type: 'number', description: 'Interned building type id' }, tx: { type: 'number', description: 'Footprint top-left tile X' }, ty: { type: 'number', description: 'Footprint top-left tile Y' }, team: { type: 'number', description: 'Team (default 0)' } }, required: ['typeId', 'tx', 'ty'] } },
    { name: 'produce', description: 'Enqueue a unit at a production building (PRODUCE). buildingUid = the building\'s stable UnitId; productTypeId = interned unit-type id to train (must be in the building\'s trains list). Read it back with get_unit (prod.queue / prod.ticksLeft).', inputSchema: { type: 'object', properties: { buildingUid: { type: 'number', description: 'Building stable UnitId' }, productTypeId: { type: 'number', description: 'Interned unit-type id to train' }, team: { type: 'number', description: 'Team (default 0)' } }, required: ['buildingUid', 'productTypeId'] } },
    { name: 'set_rally', description: 'Set a building\'s rally point (SET_RALLY) to tile (tx,ty); freshly trained units walk there.', inputSchema: { type: 'object', properties: { buildingUid: { type: 'number', description: 'Building stable UnitId' }, tx: { type: 'number', description: 'Rally tile X' }, ty: { type: 'number', description: 'Rally tile Y' }, team: { type: 'number', description: 'Team (default 0)' } }, required: ['buildingUid', 'tx', 'ty'] } },
    { name: 'cancel_produce', description: 'Cancel a building\'s queued production item at index (CANCEL_PRODUCE; 0 = the one in progress).', inputSchema: { type: 'object', properties: { buildingUid: { type: 'number', description: 'Building stable UnitId' }, index: { type: 'number', description: 'Queue index (default 0)' }, team: { type: 'number', description: 'Team (default 0)' } }, required: ['buildingUid'] } },
    // ── Pathing incidents (flag → replay → analyze → regression test) ──
    { name: 'flag_incident', description: 'Flag the current moment on the host as a pathing incident — captures a snapshot ring (lead-up) + the recent command log for retroactive analysis. Same as pressing ` in-game.', inputSchema: { type: 'object', properties: { label: { type: 'string', description: 'Optional note about what looked wrong' } } } },
    { name: 'list_incidents', description: 'List captured pathing incidents: id, tick window, label, command count, unit count, age. Use get_incident / replay_incident with an id.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_incident', description: 'An incident\'s detail by id: the command log over its window plus a compact per-unit list (uid/type/tile/footprint) from its base snapshot. The full snapshot stays server-side for replay_incident.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Incident id (from list_incidents)' } }, required: ['id'] } },
    { name: 'replay_incident', description: 'Restore a captured incident onto the host (rebuilt on its map, left PAUSED at the lead-up tick) so you can step through it and inspect with get_map / trace_unit / summarize_move. Replaces the live game. Deterministic — reproduces the incident exactly.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Incident id' } }, required: ['id'] } },
    { name: 'save_incident_test', description: 'Promote a captured incident to a permanent regression fixture at test/incidents/<id>.json (map + snapshot + commands + focus unit/goal). The runner test/pathing.incidents.test.ts replays it under CI and asserts the focus unit reaches its goal. REVIEW the generated `expect` — a legitimately-unreachable give-up is not a bug.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Incident id' } }, required: ['id'] } },
];

function callTool(request) {
    const { name, arguments: args = {} } = request.params;
    const ok  = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    const err = (msg)    => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
    const Q   = (q, params = {}) => runQuery(q, params);                  // in-process (synchronous)
    const ctrl = (cmd) => broadcastGames(JSON.stringify({ type: 'ctrl', cmd }));
    const toHost = (obj) => broadcast('host', JSON.stringify(obj));        // sim-driving verbs → referee only
    try {
        switch (name) {
            case 'get_status':   return ok(Q('status'));
            case 'get_metrics':  return ok(Q('metrics', args));
            case 'get_state': {
                const raw = Q('state', args.tick != null ? { tick: args.tick } : {});
                return ok({ tick: raw.tick, hashMatch: raw.hashMatch, host: fmtState(raw.host), peer: fmtState(raw.peer) });
            }
            case 'get_map': {
                const raw = Q('state', args.tick != null ? { tick: args.tick } : {});
                return { content: [{ type: 'text', text: args.fine ? renderWalkMap(raw.host, args.team) : renderMap(raw.host, args.team) }] };
            }
            case 'get_unit': {
                const raw = Q('unit', { uid: args.uid, ...(args.tick != null ? { tick: args.tick } : {}) });
                return ok({ tick: raw.tick, uid: raw.uid, host: fmtUnit(raw.host), peer: fmtUnit(raw.peer) });
            }
            case 'get_region':    return { content: [{ type: 'text', text: fmtRegion(Q('region', args)) }] };
            case 'trace_unit': {
                const params = {};
                if (args.uids != null) params.uids = args.uids;
                if (args.uid  != null) params.uid  = args.uid;
                if (args.from != null) params.from = args.from;
                if (args.to   != null) params.to   = args.to;
                return { content: [{ type: 'text', text: fmtTrace(Q('trace', params)) }] };
            }
            case 'summarize_move': return { content: [{ type: 'text', text: fmtSummary(Q('summarize', args.tick != null ? { tick: args.tick } : {})) }] };
            case 'get_diff':       return ok(Q('diff', args.tick != null ? { tick: args.tick } : {}));
            case 'list_commands':  return ok(Q('commands', args));
            case 'find_divergence':return ok(Q('divergence', args));
            case 'get_history_range': return ok(Q('history_range'));
            case 'get_console':       return ok(Q('console', args));
            case 'pause':  ctrl('pause');  return ok({ ok: true });
            case 'resume': ctrl('resume'); return ok({ ok: true });
            case 'move_units':    toHost({ type: 'ctrl', cmd: 'command', command: { type: 1, unitIds: args.uids ?? [], txFP: tcFP(args.tx), tyFP: tcFP(args.ty) } }); return ok({ ok: true });
            case 'stop_units':    toHost({ type: 'ctrl', cmd: 'command', command: { type: 3, unitIds: args.uids ?? [] } }); return ok({ ok: true });
            case 'spawn_unit':    toHost({ type: 'ctrl', cmd: 'command', command: { type: 2, xFP: tcFP(args.tx), yFP: tcFP(args.ty), team: args.team ?? 0, typeId: args.typeId ?? 0 } }); return ok({ ok: true });
            case 'step':          toHost({ type: 'ctrl', cmd: 'step', n: args.n ?? 1 }); return ok({ ok: true });
            case 'load_scenario': toHost({ type: 'ctrl', cmd: 'load-scenario', scenario: args.scenario }); return ok({ ok: true });
            case 'build':         toHost({ type: 'ctrl', cmd: 'command', command: { type: 4, typeId: args.typeId, tileX: args.tx, tileY: args.ty, team: args.team ?? 0 } }); return ok({ ok: true });
            case 'produce':       toHost({ type: 'ctrl', cmd: 'command', command: { type: 6, buildingUid: args.buildingUid, productTypeId: args.productTypeId, team: args.team ?? 0 } }); return ok({ ok: true });
            case 'set_rally':     toHost({ type: 'ctrl', cmd: 'command', command: { type: 7, buildingUid: args.buildingUid, txFP: tcFP(args.tx), tyFP: tcFP(args.ty), team: args.team ?? 0 } }); return ok({ ok: true });
            case 'cancel_produce':toHost({ type: 'ctrl', cmd: 'command', command: { type: 8, buildingUid: args.buildingUid, index: args.index ?? 0, team: args.team ?? 0 } }); return ok({ ok: true });
            case 'flag_incident': toHost({ type: 'ctrl', cmd: 'flag', label: args.label ?? '' }); return ok({ ok: true });
            case 'list_incidents': return ok(Q('incidents'));
            case 'get_incident': {
                const r = Q('incident', { incidentId: args.id });
                return r.error ? err(r.error) : ok(r);
            }
            case 'replay_incident': {
                const inc = incidents.find(i => i.id === args.id);
                if (!inc) return err(`no incident: ${args.id}`);
                toHost({ type: 'ctrl', cmd: 'restore', snapshot: inc.snapshot, map: inc.map });
                return ok({ ok: true, restoredToTick: inc.baseTick, flagTick: inc.flagTick, note: 'host paused at the base tick; step + get_map/trace_unit/summarize_move to analyze, then re-apply the commands below to reproduce', commands: inc.commands });
            }
            case 'save_incident_test': {
                const r = saveIncidentTest(args.id);
                return r.error ? err(r.error) : ok(r);
            }
            default: return err(`unknown tool: ${name}`);
        }
    } catch (e) {
        return err(e.message);
    }
}

function buildMcpServer() {
    const server = new Server({ name: 'war2-inspector', version: '0.2.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(request));
    return server;
}

// Stateful MCP sessions: the client sends `initialize` (no session id) → we mint a transport + session
// id (returned in the Mcp-Session-Id header) and reuse it for that client's subsequent requests / SSE
// stream. Required because the MCP Server enforces initialize-before-other-requests per connection.
const mcpSessions = new Map(); // sessionId → StreamableHTTPServerTransport

const isInitialize = (body) => {
    const check = (m) => m && typeof m === 'object' && m.method === 'initialize';
    return Array.isArray(body) ? body.some(check) : check(body);
};

/** Node http handler: MCP at /mcp (Streamable HTTP, session-managed), plus a tiny health endpoint. */
async function handleHttp(req, res) {
    if (req.url?.startsWith('/mcp')) {
        let body;
        if (req.method === 'POST') {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            try { body = JSON.parse(Buffer.concat(chunks).toString() || 'null') ?? undefined; } catch { body = undefined; }
        }

        const sessionId = req.headers['mcp-session-id'];
        let transport = sessionId ? mcpSessions.get(sessionId) : undefined;

        if (!transport) {
            if (req.method !== 'POST' || !isInitialize(body)) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'No valid session id; send an initialize request first' } }));
                return;
            }
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: true,   // single JSON response per POST (no SSE stream needed for our tools)
                onsessioninitialized: (sid) => { mcpSessions.set(sid, transport); },
            });
            transport.onclose = () => { if (transport.sessionId) mcpSessions.delete(transport.sessionId); };
            await buildMcpServer().connect(transport);
        }

        try {
            await transport.handleRequest(req, res, body);
        } catch (e) {
            if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })); }
        }
        return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, latestTick, connected: { host: !!clients.get('host')?.size, peer: !!clients.get('peer')?.size } }));
        return;
    }
    res.writeHead(404); res.end();
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

            if (role === 'metrics') {
                // Fresh bridge ⇒ the host page was (re)loaded.  Adopt it as the current
                // source and drop the previous page's perf history.
                metricsWs = ws;
                for (const r of Object.keys(metricsHistory)) delete metricsHistory[r];
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

        if (msg.type === 'diag-error' && role === 'host') { console.error(`[host diag-error]\n${msg.msg}`); return; }

        // Relayed console line from a game box (origin: worker | client) — keep a per-role ring for get_console.
        if (msg.type === 'console' && (role === 'host' || role === 'peer')) {
            const buf = consoleHistory[role];
            buf.push({ t: Date.now(), origin: msg.origin, level: msg.level, msg: msg.msg });
            if (buf.length > CONSOLE_MAX) buf.shift();
            if (msg.level === 'error') console.error(`[${role} ${msg.origin}] ${msg.msg}`);   // surface errors in stdout too
            return;
        }

        // Flagged pathing incident from the host: store with the command log over its window.
        if (msg.type === 'incident' && role === 'host') {
            const id = `inc_${++incidentSeq}`;
            const commands = cmdHistory.filter(c => c.role === 'host' && c.tick >= msg.baseTick && c.tick <= msg.flagTick);
            incidents.push({ id, flagTick: msg.flagTick, baseTick: msg.baseTick, flagHash: msg.flagHash, label: msg.label || '', snapshot: msg.snapshot, map: msg.map, commands, createdAt: Date.now() });
            if (incidents.length > INCIDENTS_MAX) incidents.shift();
            console.log(`[debug] incident ${id} captured (ticks ${msg.baseTick}‥${msg.flagTick}, ${commands.length} cmds, ${msg.snapshot?.units?.length ?? 0} units)`);
            return;
        }

        // Host page's metrics bridge: one connection (role "metrics") relays both boxes'
        // perf samples, each tagged with its game-role ("host"/"peer").  Ignore a lingering
        // older bridge after a refresh — only the most-recent one feeds the buffer.
        if (msg.type === 'metrics' && role === 'metrics') {
            if (ws !== metricsWs) return;
            const buf = (metricsHistory[msg.role] ??= []);
            buf.push({ t: msg.t, fields: msg.fields });
            if (buf.length > METRICS_CAP) buf.splice(0, buf.length - METRICS_CAP);
            return;
        }

        if (msg.type === 'query' && role === 'inspector') {
            handleQuery(ws, msg);
            return;
        }

        if (msg.type === 'ctrl' && role === 'inspector') {
            // Intercept replay-incident: resolve the stored snapshot/map and drive the host's restore.
            if (msg.cmd === 'replay-incident') {
                const inc = incidents.find(i => i.id === msg.id);
                if (inc) broadcast('host', JSON.stringify({ type: 'ctrl', cmd: 'restore', snapshot: inc.snapshot, map: inc.map }));
                console.log(`[debug] replay-incident ${msg.id} ${inc ? '→ host' : '(not found)'}`);
                return;
            }
            if (msg.cmd === 'save-incident-test') { saveIncidentTest(msg.id); return; }
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

httpServer.listen(PORT, () => console.log(`[debug] http+ws on http://localhost:${PORT}  (mcp: POST /mcp, ws: games + inspector)`));
