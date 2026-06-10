/**
 * almostnode in-browser host controller — the reusable two-box netcode harness.
 *
 * Each peer runs in its OWN almostnode box. The host page spins up N boxes (typically
 * two), points each box's preview at one game client, and pairs them via the
 * peer-ready → init handshake. The clients then connect peer-to-peer (outbound WS is
 * fine) and each renders its own game instance.
 *
 * The box itself is a thin PROXY in front of the already-built game: the outer Vite dev
 * server resolves transform / import.meta.glob / assets / bitecs and serves the graph,
 * so the box doesn't re-bundle. Per box, GameProxyServer.handleRequest:
 *   • /api/*          → custom route (future PeerJS HTTP-polling broker, etc.)
 *   • file in the VFS → ViteDevServer serves it (per-box edit-override layer)
 *   • else            → proxy to the outer dev server
 * Proxy fetches run in the host-page context (referrer /index.html, non-virtual) so the
 * SW passes them through to outer Vite — no recursion.
 *
 * This module is the imperative half of the harness; the static shell markup lives in
 * Harness.tsx, and the deploy-time SW patch lives in vite.ts.
 */
import { VirtualFS, ViteDevServer, getServerBridge, stream } from "almostnode";
import { createElement, jsxToString } from "jsx-async-runtime";
import { Harness } from "./Harness";

// ── Host ⇄ box pairing contract (the game client is the other half) ───────────────
/** A box's game client posts this to the host once its peer id is known. */
export interface PeerReadyMsg { type: "peer-ready"; selfId: string; }
/** The host posts this back to pair the two boxes once both are ready. */
export interface InitMsg { type: "init"; role: "host" | "peer"; targetId: string; }

/** One box: a virtual port (distinct from the real outer dev port), a role, a label. */
export interface BoxConfig {
    port: number;
    role: "host" | "peer";
    label: string;
}

export interface BootOptions {
    /** Title shown in the harness shell header. */
    title: string;
    /** Client document each box loads, relative to the box prefix (e.g. "client.html"). */
    clientUrl: string;
    boxes: BoxConfig[];
}

interface Pending { win: Window; id: string; role: "host" | "peer"; }

/**
 * Render the harness shell into `root`, then boot the runtime: register a proxy server
 * per box, create each box's iframe, and pair them. All JSX lives here (compiled by the
 * harness's own build), so consuming games need no JSX toolchain.
 */
export async function bootHarness(root: HTMLElement, { title, clientUrl, boxes }: BootOptions): Promise<void> {
    root.innerHTML = await jsxToString.call({}, createElement(Harness, { title }));

    const statusEl = root.querySelector<HTMLElement>("#status")!;
    const framesEl = root.querySelector<HTMLElement>("#frames")!;

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
     *  deploy base. The base is derived from this host page's own location (/games/war2/ in
     *  prod, / in dev) rather than import.meta.env.BASE_URL, which the relative build sets to
     *  "./". Paths the SW hands us may arrive base-stripped (`/client.html`) or base-included;
     *  normalise both to one base-prefixed path. */
    async function proxyToOuter(method: string, url: string, body?: any) {
        const base = location.pathname.replace(/[^/]*$/, "");
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

    // ── Per-box server: route + VFS-override + proxy ──────────────────────────────
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

    // ── Box pairing (peer-ready → init) ───────────────────────────────────────────
    const ready: Pending[] = [];
    const winRole = new Map<Window, "host" | "peer">();

    window.addEventListener("message", (e: MessageEvent) => {
        const d = e.data as Partial<PeerReadyMsg> | null;
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
        host.win.postMessage({ type: "init", role: "host", targetId: peer.id } satisfies InitMsg, "*");
        peer.win.postMessage({ type: "init", role: "peer", targetId: host.id } satisfies InitMsg, "*");
        log("paired → init sent to both boxes", "ok");
    }

    // ── Boot: a box + client preview per BoxConfig ────────────────────────────────
    async function boot(): Promise<void> {
        try {
            const bridge = getServerBridge();
            await bridge.initServiceWorker();
            log("service worker ready", "ok");

            for (const box of boxes) {
                bridge.registerServer(new GameProxyServer(new VirtualFS(), { port: box.port }), box.port);

                const wrap = document.createElement("div");
                wrap.className = "box-wrap";
                const label = document.createElement("span");
                label.className = "box-label";
                label.textContent = box.label;
                const iframe = document.createElement("iframe");
                // Load the client UNDER the box's virtual prefix so its requests route through
                // this box (proxy/override), and so window.parent === this host (for pairing).
                iframe.src = `__virtual__/${box.port}/${clientUrl}`;
                wrap.append(label, iframe);
                framesEl.appendChild(wrap);

                iframe.addEventListener("load", () => winRole.set(iframe.contentWindow!, box.role));
                // set role mapping eagerly too (load may fire after peer-ready in some browsers)
                winRole.set(iframe.contentWindow!, box.role);
                log(`box ${box.port} (${box.role}) → /__virtual__/${box.port}/${clientUrl}`, "ok");
            }
        } catch (err) {
            log(`BOOT FAILED: ${(err as Error)?.stack ?? err}`, "err");
        }
    }

    // ── Host-driven reload (all boxes) ────────────────────────────────────────────
    const reloadBtn = root.querySelector<HTMLButtonElement>("#reload-boxes")!;
    reloadBtn.onclick = () => { ready.length = 0; location.reload(); };

    log("almostnode: starting boxes…");
    void boot();
}
