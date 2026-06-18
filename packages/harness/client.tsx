/** @jsxImportSource preact */
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
import { render } from "preact";
import { VtWindow } from "window";

/** The harness shell as a JSX component. Render it into your host element (e.g. with
 *  jsx-async-runtime's `jsxToString`), then call {@link wireHarness} on that element to
 *  boot the runtime. Exposed so consuming games can compose the shell in their own JSX. */
export { Harness } from "./Harness";

// ── Host ⇄ box pairing contract (the game client is the other half) ───────────────
/** A box's game client posts this to the host once its peer id is known. */
export interface PeerReadyMsg { type: "peer-ready"; selfId: string; }
/** The host posts this back to pair the two boxes once both are ready. */
export interface InitMsg { type: "init"; role: "host" | "peer"; targetId: string; }
/** A box's game client posts this to the host once its renderer is up — the host
 *  uses it to minimize a windowed box only AFTER it has initialized at full size
 *  (minimizing first hides the iframe, so the renderer would boot at 0×0). */
export interface ClientReadyMsg { type: "client-ready"; }

/** One box: a virtual port (distinct from the real outer dev port), a role, a label. */
export interface BoxConfig {
    port: number;
    role: "host" | "peer";
    label: string;
    /** Mount this box in a floating VtWindow (draggable / minimizable / detachable)
     *  instead of inline in #frames.  Defaults to inline. */
    windowed?: boolean;
    /** For a windowed box: collapse it to the minimized strip once every box's
     *  renderer is up (kept available but out of the way for debugging).  Requires
     *  `windowed`.  Defaults to staying open. */
    startMinimized?: boolean;
}

export interface WireOptions {
    /** Client document each box loads, relative to the box prefix (e.g. "client.html"). */
    clientUrl: string;
    boxes: BoxConfig[];
}

interface Pending { win: Window; id: string; role: "host" | "peer"; }

/**
 * Wire the harness runtime onto an already-rendered shell: register a proxy server per
 * box, create each box's iframe, and pair them. The {@link Harness} shell must already be
 * mounted in `root` — the consuming game renders it as JSX, keeping this module free of any
 * JSX toolchain.
 */
export async function wireHarness(root: HTMLElement, { clientUrl, boxes }: WireOptions): Promise<void> {
    // Inline (non-windowed) boxes go in a #frames row, created on first use so the
    // default page stays just the floating windows (+ whatever the host mounts itself).
    let framesEl: HTMLElement | null = null;
    const ensureFrames = (): HTMLElement => {
        if (!framesEl) { framesEl = document.createElement("div"); framesEl.id = "frames"; root.appendChild(framesEl); }
        return framesEl;
    };

    function log(msg: string, cls: "ok" | "err" | "info" = "info"): void {
        // eslint-disable-next-line no-console
        (cls === "err" ? console.error : console.log)(`[almostnode] ${msg}`);
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
    // Callbacks that minimize a startMinimized window — run once every box's
    // renderer is up (see client-ready), so all boxes initialize at full size first.
    const minimizeWhenReady: Array<() => void> = [];
    const clientReady = new Set<Window>();

    window.addEventListener("message", (e: MessageEvent) => {
        const d = e.data as { type?: string; selfId?: string } | null;
        if (!d || typeof d !== "object") return;

        if (d.type === "peer-ready") {
            const role = winRole.get(e.source as Window);
            if (!role) return;
            ready.push({ win: e.source as Window, id: d.selfId as string, role });
            log(`${role} peer-ready id=${d.selfId}`, "ok");
            if (ready.length === 2) pair();
        } else if (d.type === "client-ready") {
            clientReady.add(e.source as Window);
            // Wait until EVERY box's renderer is up before collapsing the
            // start-minimized ones, so all boxes initialize under the same full-size
            // conditions (no boot-time asymmetry from one being hidden early).
            if (clientReady.size >= boxes.length) {
                for (const minimize of minimizeWhenReady) minimize();
            }
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

            let windowOffset = 0;
            for (const box of boxes) {
                bridge.registerServer(new GameProxyServer(new VirtualFS(), { port: box.port }), box.port);

                const iframe = document.createElement("iframe");
                // Load the client UNDER the box's virtual prefix so its requests route through
                // this box (proxy/override), and so window.parent === this host (for pairing).
                iframe.src = `__virtual__/${box.port}/${clientUrl}`;

                if (box.windowed) {
                    // Floating, draggable, minimizable, detachable VtWindow (Preact).  The
                    // iframe is the body; the component appends it once and never recreates
                    // it (recreating reloads it, dropping the box's P2P connection).
                    const container = document.createElement("div");
                    document.body.appendChild(container);
                    // Cascade the floating boxes down from near the top of the page.
                    const winTop = 150 + windowOffset, winLeft = 60 + windowOffset;
                    let minimized = false;
                    const draw = (): void => {
                        render(
                            <VtWindow
                                title={box.label} body={iframe}
                                top={winTop} left={winLeft} width={560} height={440}
                                detachable closable={false}   // closing would orphan the box
                                minimized={minimized}
                                onMinimizedChange={(m) => { minimized = m; draw(); }}
                            />,
                            container,
                        );
                    };
                    draw();
                    // Defer minimize until every box has booted (client-ready) — booting
                    // while minimized (display:none) would init the canvas at 0×0.
                    if (box.startMinimized) minimizeWhenReady.push(() => { minimized = true; draw(); });
                    windowOffset += 40;
                } else {
                    const wrap = document.createElement("div");
                    wrap.className = "box-wrap";
                    const label = document.createElement("span");
                    label.className = "box-label";
                    label.textContent = box.label;
                    wrap.append(label, iframe);
                    ensureFrames().appendChild(wrap);
                }

                iframe.addEventListener("load", () => winRole.set(iframe.contentWindow!, box.role));
                // set role mapping eagerly too (load may fire after peer-ready in some browsers)
                winRole.set(iframe.contentWindow!, box.role);
                log(`box ${box.port} (${box.role})${box.windowed ? " [windowed]" : ""} → /__virtual__/${box.port}/${clientUrl}`, "ok");
            }
        } catch (err) {
            log(`BOOT FAILED: ${(err as Error)?.stack ?? err}`, "err");
        }
    }

    log("almostnode: starting boxes…");
    void boot();
}
