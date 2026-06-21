/**
 * Debug-server inspector client for the e2e suite — a WS connection (role "inspector") to
 * tools/debug-server.mjs (:9229). Same channel the MCP tools use: `query` for reads, `ctrl` for
 * driving (load-scenario / command / step). The Playwright harness is "just another inspector".
 */
import { WebSocket } from "ws";

export interface Inspector {
    query(q: string, params?: Record<string, unknown>): Promise<any>;
    ctrl(obj: Record<string, unknown>): void;
    close(): void;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function connectInspector(url = "ws://localhost:9229"): Promise<Inspector> {
    const ws = new WebSocket(url);
    let idc = 0;
    const pending = new Map<string, { res: (v: any) => void; rej: (e: Error) => void }>();

    ws.on("message", (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "query-result") { pending.get(m.id)?.res(m.result); pending.delete(m.id); }
        if (m.type === "query-error")  { pending.get(m.id)?.rej(new Error(m.message)); pending.delete(m.id); }
    });

    await new Promise<void>((resolve, reject) => {
        ws.on("open", () => { ws.send(JSON.stringify({ type: "hello", role: "inspector" })); resolve(); });
        ws.on("error", reject);
    });

    return {
        query: (q, params = {}) => new Promise((res, rej) => {
            const id = String(++idc);
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ type: "query", id, query: q, ...params }));
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`query timeout: ${q}`)); } }, 5000);
        }),
        ctrl: (obj) => ws.send(JSON.stringify({ type: "ctrl", ...obj })),
        close: () => ws.close(),
    };
}

/** Poll until a host referee is connected to the debug server (page booted), or time out. */
export async function waitForHost(insp: Inspector, ms = 30000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if ((await insp.query("status")).connected?.host) return true;
        await sleep(500);
    }
    return false;
}
