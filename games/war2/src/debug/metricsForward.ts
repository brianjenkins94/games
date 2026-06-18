/**
 * Metrics → debug-server bridge (host page, dev only).
 *
 * The perf dashboard ({@link mountMetrics}) consumes `{type:"metrics"}` window messages that
 * each box's client shell forwards to this page (one per box: host + guest).  This bridge is a
 * second, independent consumer of those same messages: it re-broadcasts each sample onto the
 * debug WebSocket (tools/debug-server.mjs) as role `"metrics"`, so the MCP inspector's
 * `get_metrics` query can read the live perf of both boxes — the same view as the on-page charts.
 *
 * Decoupled from the metrics package on purpose: it just listens on `window`, so the package
 * stays game-agnostic and this war2-specific debug wiring lives here.  Tree-shaken in prod.
 */

const DEBUG_WS_URL = "ws://localhost:9229";

/** A perf sample as forwarded by a box's client shell (see client/main.ts onMetrics). */
interface MetricsMsg { type: "metrics"; role: string; t: number; fields: Record<string, number>; }

export function forwardMetricsToDebug(): void {
    if (!import.meta.env.DEV) return;

    let socket: WebSocket | null = null;
    try {
        socket = new WebSocket(DEBUG_WS_URL);
        socket.addEventListener("open", () => socket!.send(JSON.stringify({ type: "hello", role: "metrics" })));
        socket.addEventListener("error", () => { socket = null; });
        socket.addEventListener("close", () => { socket = null; });
    } catch {
        socket = null;
    }

    window.addEventListener("message", (e: MessageEvent) => {
        const d = e.data as MetricsMsg | null;
        if (!d || d.type !== "metrics") return;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "metrics", role: d.role, t: d.t, fields: d.fields }));
    });
}
