/**
 * almostnode in-browser host controller — the war2 harness (served at index.html).
 *
 * Each peer runs in its OWN almostnode box. The host page (this file) spins up TWO
 * boxes, points each box's preview at one war2 client, and pairs them via the
 * peer-ready → init handshake. The two clients then connect peer-to-peer via the
 * :9000 broker (outbound WS is fine) and each renders its own game instance.
 *
 * The box itself is a thin PROXY in front of the already-built game: the outer war2 Vite
 * dev server resolves transform / import.meta.glob / assets / bitecs and serves the graph,
 * so the box doesn't re-bundle. Per box, GameProxyServer.handleRequest:
 *   • /api/*          → custom route (future PeerJS HTTP-polling broker, etc.)
 *   • file in the VFS → ViteDevServer serves it (per-box edit-override layer)
 *   • else            → proxy to the outer dev server
 * Proxy fetches run in this host-page context (referrer /index.html, non-virtual) so
 * the SW passes them through to outer Vite — no recursion.
 */
import { VirtualFS, ViteDevServer, getServerBridge, stream } from "almostnode";

// One virtual port per box (distinct from the real outer 5173).
const BOXES = [
    { port: 5273, role: "host" as const, label: "BOX A · host" },
    { port: 5274, role: "peer" as const, label: "BOX B · peer" },
];

// ── Host UI ─────────────────────────────────────────────────────────────────────
const statusEl = document.getElementById("status")!;
const framesEl = document.getElementById("frames")!;

function log(msg: string, cls: "ok" | "err" | "info" = "info"): void {
    const line = document.createElement("div");
    line.className = cls;
    line.textContent = `${new Date().toISOString().slice(11, 23)}  ${msg}`;
    statusEl.appendChild(line);
    statusEl.scrollTop = statusEl.scrollHeight;
    // eslint-disable-next-line no-console
    console.log(`[almostnode] ${msg}`);
}
window.addEventListener("error", (e) => log(`window error: ${e.message}`, "err"));
window.addEventListener("unhandledrejection", (e) => log(`unhandled rejection: ${e.reason}`, "err"));

/** Fetch a resource from the outer server (same origin → SW passes through), under the
 *  app base. The SW hands matched virtual paths base-stripped (`/client.html`) and
 *  referer-forwarded paths base-included (`/games/war2/client.js`); normalise both to a
 *  single base-prefixed path. In dev BASE_URL is "/", so this is a no-op there. */
async function proxyToOuter(method: string, url: string, body?: any) {
    const base = import.meta.env.BASE_URL;
    const rel = url.startsWith(base) ? url.slice(base.length) : url.replace(/^\//, "");
    const res = await fetch(location.origin + base + rel, { method, body: method === "GET" || method === "HEAD" ? undefined : body });
    const ab = await res.arrayBuffer();
    return {
        statusCode: res.status,
        statusMessage: res.statusText || "OK",
        headers: { "content-type": res.headers.get("content-type") || "application/octet-stream", "cache-control": "no-cache" },
        body: stream.Buffer.from(ab),
    };
}

// ── Per-box server: route + VFS-override + proxy ──────────────────────────────────
class GameProxyServer extends ViteDevServer {
    async handleRequest(method: string, url: string, headers: Record<string, string>, body?: any) {
        const path = url.split("?")[0];
        if (path.startsWith("/api/")) {
            const payload = JSON.stringify({ route: path, method, ok: true, serverTime: new Date().toISOString() });
            return { statusCode: 200, statusMessage: "OK", headers: { "content-type": "application/json" }, body: stream.Buffer.from(payload) };
        }
        try {
            if (path !== "/" && this.exists(this.resolvePath(path))) {
                return await super.handleRequest(method, url, headers, body); // VFS override
            }
        } catch { /* fall through */ }
        return await proxyToOuter(method, url, body);
    }
}

// ── Box pairing (peer-ready → init) ────────────────────────────────────────────────
interface Pending { win: Window; id: string; role: "host" | "peer"; }
const ready: Pending[] = [];
const winRole = new Map<Window, "host" | "peer">();

window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data;
    if (!d || typeof d !== "object") return;

    if (d.type === "peer-ready") {
        const role = winRole.get(e.source as Window);
        if (!role) return;
        ready.push({ win: e.source as Window, id: d.selfId as string, role });
        log(`${role} peer-ready id=${d.selfId}`, "ok");
        if (ready.length === 2) pair();
    }
});

function pair(): void {
    const host = ready.find((r) => r.role === "host")!;
    const peer = ready.find((r) => r.role === "peer")!;
    // host connects to peer's id; peer waits for host's id.
    host.win.postMessage({ type: "init", role: "host", targetId: peer.id }, "*");
    peer.win.postMessage({ type: "init", role: "peer", targetId: host.id }, "*");
    log("paired → init sent to both boxes", "ok");
}

// ── Boot: two boxes, two client previews ──────────────────────────────────────────
async function boot(): Promise<void> {
    try {
        const bridge = getServerBridge();
        await bridge.initServiceWorker();
        log("service worker ready", "ok");

        for (const box of BOXES) {
            bridge.registerServer(new GameProxyServer(new VirtualFS(), { port: box.port }), box.port);

            const wrap = document.createElement("div");
            wrap.className = "box-wrap";
            const label = document.createElement("span");
            label.className = "box-label";
            label.textContent = box.label;
            const iframe = document.createElement("iframe");
            // Load the client UNDER the box's virtual prefix so its requests route through
            // this box (proxy/override), and so window.parent === this host (for pairing).
            iframe.src = `__virtual__/${box.port}/client.html`;
            wrap.append(label, iframe);
            framesEl.appendChild(wrap);

            iframe.addEventListener("load", () => winRole.set(iframe.contentWindow!, box.role));
            // set role mapping eagerly too (load may fire after peer-ready in some browsers)
            winRole.set(iframe.contentWindow!, box.role);
            log(`box ${box.port} (${box.role}) → /__virtual__/${box.port}/client.html`, "ok");
        }
    } catch (err) {
        log(`BOOT FAILED: ${(err as Error)?.stack ?? err}`, "err");
    }
}

// ── Host-driven reload (both boxes) ───────────────────────────────────────────────
const reloadBtn = document.createElement("button");
reloadBtn.textContent = "⟳ Reload both boxes";
reloadBtn.onclick = () => { ready.length = 0; location.reload(); };
statusEl.insertAdjacentElement("afterend", reloadBtn);

log("almostnode: starting two boxes…");
void boot();
