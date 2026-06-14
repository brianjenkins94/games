#!/usr/bin/env node
/**
 * War2 MCP inspector — exposes game state as Claude Code tools.
 *
 * Connects to tools/debug-server.mjs (port 9229) as an "inspector" and wraps
 * the query protocol in MCP tool calls.  Add once to .mcp.json; Claude Code
 * launches it automatically.
 *
 * Tools:
 *   get_status        connection state, tick, history availability
 *   get_state         full unit table at a tick (default: latest)
 *   get_unit          single unit on host + peer at a tick
 *   get_diff          host vs peer field comparison at a tick
 *   list_commands     command log slice by tick range
 *   find_divergence   first tick in range where hashes diverge
 *   get_history_range min/max tick stored in server
 *   pause / resume    sim flow control
 */

import { Server }              from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocket } from 'ws';

const WS_URL = 'ws://localhost:9229';
const DIR    = ['N','NE','E','SE','S','SW','W','NW'];

// ── Debug-server connection ───────────────────────────────────────────────────

let ws        = null;
let wsReady   = false;
let idCounter = 0;
const pending = new Map(); // id → { resolve, reject, timer }

function connect() {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        wsReady = true;
        ws.send(JSON.stringify({ type: 'hello', role: 'inspector' }));
    });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'query-result' || msg.type === 'query-error') {
            const p = pending.get(msg.id);
            if (!p) return;
            clearTimeout(p.timer);
            pending.delete(msg.id);
            if (msg.type === 'query-result') p.resolve(msg.result);
            else                             p.reject(new Error(msg.message));
        }
    });

    ws.on('close', () => {
        wsReady = false;
        for (const [id, p] of pending) {
            clearTimeout(p.timer);
            p.reject(new Error('debug server disconnected'));
        }
        pending.clear();
        setTimeout(connect, 2000);
    });

    ws.on('error', () => {}); // surfaced via 'close'
}

connect();

function query(q, params = {}) {
    if (!wsReady) {
        return Promise.reject(new Error('not connected to debug server — is `npm run dev` running?'));
    }
    return new Promise((resolve, reject) => {
        const id    = String(++idCounter);
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('query timed out'));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ type: 'query', id, query: q, ...params }));
    });
}

function ctrl(cmd) {
    if (wsReady) ws.send(JSON.stringify({ type: 'ctrl', cmd }));
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtUnit(u) {
    if (!u) return null;
    const px = u.px != null ? u.px / 1000 : null;
    const py = u.py != null ? u.py / 1000 : null;
    // how far the unit centre sits from its tile centre, in px (0,0 = perfectly grid-aligned)
    const off = px != null ? [Math.round(((px % 32) + 32) % 32 - 16), Math.round(((py % 32) + 32) % 32 - 16)] : null;
    return {
        uid:        u.uid,
        team:       u.team,
        tile:       [u.curTx, u.curTy],
        pos:        px != null ? [Math.round(px), Math.round(py)] : null,
        offCentre:  off,
        box:        u.hw != null ? [u.hw * 2, u.hh * 2] : null,
        goal:       u.pathActive ? [u.goalTx, u.goalTy] : null,
        stuck:      u.stuckTicks ?? 0,
        dir:        DIR[u.dir] ?? u.dir,
        moving:     !!u.moving,
        pathActive: !!u.pathActive,
        moveActive: !!u.moveActive,
    };
}

function fmtState(blob) {
    if (!blob) return null;
    return {
        tick:  blob.tick,
        hash:  (blob.hash >>> 0).toString(16).padStart(8, '0'),
        units: (blob.units ?? []).map(fmtUnit),
    };
}

/**
 * Render an ASCII top-down view of a state blob: unit positions + the active gather block,
 * so holes (unfilled slots) and stragglers (units off the block) are visible at a glance.
 *   UPPER = settled unit, lower = moving unit  (a/A = team 0, b/B = team 1)
 *   o = empty gather slot (a hole)   · = empty tile
 */
function renderMap(blob, teamFilter, ascii) {
    if (!blob) return 'no state at that tick';
    const inTeam = (t) => teamFilter == null || t === teamFilter;

    const gather     = blob.gatherSlots ?? {};
    const slotTiles  = Object.entries(gather).filter(([t]) => inTeam(Number(t))).flatMap(([, s]) => s);
    const slotSet    = new Set(slotTiles.map(([x, y]) => `${x},${y}`));
    const unitPts    = (blob.units ?? []).filter(u => inTeam(u.team)).map(u => ({ x: u.curTx, y: u.curTy, u }));
    if (!unitPts.length && !slotTiles.length) return '(no units / no gather block at that tick)';

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { x, y } of unitPts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (const [x, y] of slotTiles) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    minX--; minY--; maxX++; maxY++;
    const W = maxX - minX + 1, H = maxY - minY + 1;
    if (W > 160 || H > 160) return `region too large to render (${W}×${H}) — the units are spread out, not gathered.`;

    const unitAt = new Map();
    for (const p of unitPts) unitAt.set(`${p.x},${p.y}`, p.u);

    const rows = [];
    for (let y = minY; y <= maxY; y++) {
        let row = '';
        for (let x = minX; x <= maxX; x++) {
            const key = `${x},${y}`;
            const u = unitAt.get(key);
            if (u)                   { const c = u.team === 0 ? 'a' : 'b'; row += u.moveActive ? c : c.toUpperCase(); }
            else if (slotSet.has(key)) row += 'o';
            else                       row += '·';
        }
        rows.push(row);
    }

    const filled     = slotTiles.filter(([x, y]) => unitAt.has(`${x},${y}`)).length;
    const moving     = unitPts.filter(p => p.u.moveActive).length;
    const stragglers = slotSet.size ? unitPts.filter(p => !slotSet.has(`${p.x},${p.y}`)).length : 0;
    const summary = [
        `${unitPts.length} units (moving ${moving}, settled ${unitPts.length - moving}) in tiles [${minX + 1},${minY + 1}]‥[${maxX - 1},${maxY - 1}]`,
        slotTiles.length ? `gather slots: ${slotTiles.length}  filled ${filled}  HOLES ${slotTiles.length - filled}  stragglers ${stragglers}` : 'no active gather block',
    ];
    if (ascii) summary.push('legend: UPPER=settled lower=moving (a/A team0, b/B team1), o=hole, ·=empty', '', ...rows);
    return summary.join('\n');
}

/**
 * Fine 8px walk-grid view from real pixel positions + box extents (not tile buckets) — this is
 * what reveals sub-tile gaps that the 32px-tile render hides.  Lowercase = footprint cell,
 * UPPER = the unit's centre cell, '#' = two footprints overlapping (a bug), '·' = free.
 * 4 chars = one 32px tile.  Per-unit lines show off-centre offset (0,0 = perfectly aligned).
 */
function renderWalkMap(blob, teamFilter, ascii) {
    if (!blob) return 'no state at that tick';
    const CELL = 8;
    const inTeam = (t) => teamFilter == null || t === teamFilter;
    const units = (blob.units ?? []).filter(u => inTeam(u.team) && u.px != null);
    if (!units.length) return '(no units with position data — reload the dev game so it streams px/hw)';

    const boxes = units.map(u => {
        const cx = u.px / 1000, cy = u.py / 1000, hw = u.hw ?? 16, hh = u.hh ?? 16;
        return {
            u,
            l: Math.floor((cx - hw) / CELL), r: Math.floor((cx + hw - 1) / CELL),
            t: Math.floor((cy - hh) / CELL), b: Math.floor((cy + hh - 1) / CELL),
            ccx: Math.floor(cx / CELL), ccy: Math.floor(cy / CELL),
        };
    });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes) { minX = Math.min(minX, b.l); maxX = Math.max(maxX, b.r); minY = Math.min(minY, b.t); maxY = Math.max(maxY, b.b); }
    const PAD = 2; minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
    const W = maxX - minX + 1, H = maxY - minY + 1;
    if (W > 220 || H > 220) return `region too large at 8px resolution (${W}×${H} cells) — filter by team or zoom in by tick.`;

    // footprint cells per unit — built from ALL units (not the team filter), else another
    // team's legitimate reservations look like phantoms.
    const footByEid = new Map();
    const footSet = new Set();        // team-filtered footprints, for the 'o' overlay only
    for (const u of (blob.units ?? [])) {
        if (u.px == null) continue;
        const cx = u.px / 1000, cy = u.py / 1000, hw = u.hw ?? 16, hh = u.hh ?? 16;
        const l = Math.floor((cx - hw) / CELL), r = Math.floor((cx + hw - 1) / CELL);
        const tt = Math.floor((cy - hh) / CELL), bb = Math.floor((cy + hh - 1) / CELL);
        const s = new Set();
        for (let y = tt; y <= bb; y++) for (let x = l; x <= r; x++) { s.add(`${x},${y}`); if (inTeam(u.team)) footSet.add(`${x},${y}`); }
        footByEid.set(u.eid, s);
    }
    // real reservations streamed from the sim: [cellX, cellY, ownerEid]
    const reserved = blob.reserved ?? [];
    const resAt = new Map(reserved.map(([cx, cy, owner]) => [`${cx},${cy}`, owner]));

    // expand region to include any reserved cells too (a phantom may sit outside footprints)
    for (const [cx, cy] of reserved) { minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy); }
    const W2 = maxX - minX + 1, H2 = maxY - minY + 1;
    if (W2 > 240 || H2 > 240) return `region too large (${W2}×${H2})`;

    const uidOf = new Map(blob.units.map(u => [u.eid, u.uid]));
    // Anomalies: phantom reservations (reserved cell, owner not actually there) + overlaps.
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
    const out = [
        `${units.length} units: ${units.length - offGrid.length} grid-aligned, ${offGrid.length} off-centre`,
        ...offGrid.map(u => {
            const [ox, oy] = offOf(u);
            return `  uid${u.uid} tile(${u.curTx},${u.curTy}) off(${ox},${oy}) stuck${u.stuckTicks ?? 0} ${u.moveActive ? 'active' : 'settled'}`;
        }),
        reserved.length ? `reservations ${reserved.length}; PHANTOMS ${phantomCells.length}; overlaps ${overlaps.length}; footprint-unreserved ${unreserved}` : 'no reservation data (reload dev game)',
        ...phantomCells.slice(0, 24).map(([cx, cy, o]) => `  PHANTOM cell(${cx},${cy}) owner uid${uidOf.get(o) ?? '?'}`),
        ...overlaps.slice(0, 12).map(k => `  OVERLAP cell(${k})`),
    ];
    if (!ascii) return out.join('\n');

    // Full ASCII grid (opt-in): UPPER=centre, lower=reserved+footprint, X=phantom, o=unreserved footprint.
    const grid = Array.from({ length: H2 }, () => Array(W2).fill('·'));
    for (let cy = minY; cy <= maxY; cy++) for (let cx = minX; cx <= maxX; cx++) {
        const key = `${cx},${cy}`, gx = cx - minX, gy = cy - minY, owner = resAt.get(key);
        if (owner != null) grid[gy][gx] = footByEid.get(owner)?.has(key) ? ((uidOf.get(owner) != null && blob.units.find(u => u.eid === owner)?.team === 0) ? 'a' : 'b') : 'X';
        else if (footSet.has(key)) grid[gy][gx] = 'o';
    }
    for (const b of boxes) { const gx = b.ccx - minX, gy = b.ccy - minY; if (grid[gy]?.[gx] && grid[gy][gx] !== 'X') grid[gy][gx] = b.u.team === 0 ? 'A' : 'B'; }
    out.push(`legend: UPPER=centre, lower=ok, X=PHANTOM, o=unreserved, ·=free  cells[${minX},${minY}]‥[${maxX},${maxY}]`, '', ...grid.map(r => r.join('')));
    return out.join('\n');
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
    { name: 'war2-inspector', version: '0.1.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name:        'get_status',
            description: 'Check whether host/peer are connected, the current tick, and how much history is available.',
            inputSchema: { type: 'object', properties: {} },
        },
        {
            name:        'get_state',
            description: 'Get full game state (all units, hash) for host and peer at a tick. Omit tick for latest.',
            inputSchema: {
                type: 'object',
                properties: { tick: { type: 'number', description: 'Tick to inspect (omit = latest)' } },
            },
        },
        {
            name:        'get_map',
            description: 'Compact spatial diagnostic of units (host) at a tick: per-unit off-centre offsets, and lists of phantom/overlap/hole cells. Pass fine=true for the 8px walk grid (reservations + sub-tile offsets) vs the default 32px tile summary. Pass ascii=true to also include the full character-grid picture (token-heavy — only when you need the visual shape).',
            inputSchema: {
                type:       'object',
                properties: {
                    tick:  { type: 'number',  description: 'Tick to inspect (omit = latest)' },
                    team:  { type: 'number',  description: 'Only show this team (omit = all)' },
                    fine:  { type: 'boolean', description: 'Use the 8px walk grid (reservations, sub-tile) instead of 32px tiles' },
                    ascii: { type: 'boolean', description: 'Also dump the full ASCII grid (expensive; default off)' },
                },
            },
        },
        {
            name:        'get_unit',
            description: 'Get one unit\'s state on both host and peer at a tick.',
            inputSchema: {
                type:       'object',
                properties: {
                    uid:  { type: 'number', description: 'Unit ID' },
                    tick: { type: 'number', description: 'Tick to inspect (omit = latest)' },
                },
                required: ['uid'],
            },
        },
        {
            name:        'get_diff',
            description: 'Compare host vs peer at a tick — shows per-unit field divergences and whether hashes match.',
            inputSchema: {
                type: 'object',
                properties: { tick: { type: 'number', description: 'Tick to diff (omit = latest)' } },
            },
        },
        {
            name:        'list_commands',
            description: 'Show commands applied in a tick range (both roles).',
            inputSchema: {
                type: 'object',
                properties: {
                    from: { type: 'number', description: 'Start tick (inclusive)' },
                    to:   { type: 'number', description: 'End tick (inclusive)' },
                },
            },
        },
        {
            name:        'find_divergence',
            description: 'Scan a tick range and return the first tick where host and peer hashes diverge, plus the diff at that tick.',
            inputSchema: {
                type: 'object',
                properties: {
                    from: { type: 'number', description: 'Start tick (inclusive, omit = beginning of history)' },
                    to:   { type: 'number', description: 'End tick (inclusive, omit = latest)' },
                },
            },
        },
        {
            name:        'get_history_range',
            description: 'Get the min and max tick stored in the debug server.',
            inputSchema: { type: 'object', properties: {} },
        },
        {
            name:        'pause',
            description: 'Pause the game simulation on both host and peer.',
            inputSchema: { type: 'object', properties: {} },
        },
        {
            name:        'resume',
            description: 'Resume the game simulation on both host and peer.',
            inputSchema: { type: 'object', properties: {} },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    const ok  = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    const err = (msg)    => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

    try {
        switch (name) {
            case 'get_status':
                return ok(await query('status'));

            case 'get_state': {
                const raw = await query('state', args.tick != null ? { tick: args.tick } : {});
                return ok({ tick: raw.tick, hashMatch: raw.hashMatch, host: fmtState(raw.host), peer: fmtState(raw.peer) });
            }

            case 'get_map': {
                const raw = await query('state', args.tick != null ? { tick: args.tick } : {});
                const text = args.fine ? renderWalkMap(raw.host, args.team, args.ascii) : renderMap(raw.host, args.team, args.ascii);
                return { content: [{ type: 'text', text }] };
            }

            case 'get_unit': {
                const raw = await query('unit', { uid: args.uid, ...(args.tick != null ? { tick: args.tick } : {}) });
                return ok({ tick: raw.tick, uid: raw.uid, host: fmtUnit(raw.host), peer: fmtUnit(raw.peer) });
            }

            case 'get_diff':
                return ok(await query('diff', args.tick != null ? { tick: args.tick } : {}));

            case 'list_commands':
                return ok(await query('commands', args));

            case 'find_divergence':
                return ok(await query('divergence', args));

            case 'get_history_range':
                return ok(await query('history_range'));

            case 'pause':
                ctrl('pause');
                return ok({ ok: true });

            case 'resume':
                ctrl('resume');
                return ok({ ok: true });

            default:
                return err(`unknown tool: ${name}`);
        }
    } catch (e) {
        return err(e.message);
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
