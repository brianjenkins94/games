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
    return {
        uid:        u.uid,
        team:       u.team,
        tile:       [u.curTx, u.curTy],
        goal:       u.pathActive ? [u.goalTx, u.goalTy] : null,
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
