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
// Connection model: the host box dials, the guest box listens. Roles travel in the box URL, so a box
// reloaded into a popped-out tab is still pairable. See games/war2/docs/box-reconnection.md.
/** A box posts this once its peer id is known (on first boot AND after a reload/reconnect). */
export interface PeerReadyMsg { type: "peer-ready"; role: "host" | "peer"; selfId: string; }
/** Host-only: (re)dial the guest at this id. Re-sent on every (re)announce → graceful reconnect. */
export interface ConnectMsg { type: "connect"; targetId: string; }
/** A box posts this once its renderer is up — the host uses it to minimize a windowed box only AFTER
 *  it has initialized at full size (minimizing first hides the iframe, so it would boot at 0×0). */
export interface ClientReadyMsg { type: "client-ready"; role: "host" | "peer"; }

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

/** A booted box: its virtual port, role, and the VirtualFS that overrides the proxied game
 *  files. Write into `vfs` (path as the box serves it, e.g. "/src/foo.ts") to live-edit what
 *  the box runs — the GameProxyServer serves VFS entries instead of proxying to the outer server. */
export interface BoxHandle {
    port: number;
    role: "host" | "peer";
    vfs: VirtualFS;
    /** Relay a message into the box's client (its window.addEventListener("message") pump). */
    post(msg: unknown): void;
}

/**
 * Wire the harness runtime onto an already-rendered shell: register a proxy server per
 * box, create each box's iframe, and pair them. The {@link Harness} shell must already be
 * mounted in `root` — the consuming game renders it as JSX, keeping this module free of any
 * JSX toolchain.
 */
export async function wireHarness(root: HTMLElement, { clientUrl, boxes }: WireOptions): Promise<{ boxes: BoxHandle[]; swapHost: () => void }> {
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

    // ── Box pairing: host dials, guest listens ────────────────────────────────────
    // Role-keyed by the role each box announces (it reads it from its own URL), so a box reloaded
    // into a popped-out tab is still pairable. The one rule: whenever both boxes are present, tell the
    // host to (re)dial the current guest. Re-firing on any re-announce IS graceful reconnection.
    const boxesByRole = new Map<"host" | "peer", { win: Window; id: string }>();
    // Callbacks that minimize a startMinimized window — run once every box's renderer is up.
    const minimizeWhenReady: Array<() => void> = [];
    const clientReady = new Set<"host" | "peer">();
    // Latest authoritative-state heartbeat from the host box (opaque to the harness). Sent back as a
    // `restore` when a host box (re)announces, so a popped-out / re-attached / recycled host resumes
    // the game instead of reseeding. See games/war2/docs/box-reconnection.md (Phase B).
    let hostSnapshot: unknown;

    window.addEventListener("message", (e: MessageEvent) => {
        const d = e.data as { type?: string; role?: "host" | "peer"; selfId?: string; snap?: unknown } | null;
        if (!d || typeof d !== "object") return;

        if (d.type === "peer-ready" && d.role && d.selfId) {
            boxesByRole.set(d.role, { win: e.source as Window, id: d.selfId });
            log(`${d.role} peer-ready id=${d.selfId}`, "ok");
            // Hand a (re)booting host its last known state before we pair it, so it resumes the game.
            if (d.role === "host" && hostSnapshot !== undefined) {
                (e.source as Window).postMessage({ type: "restore", snap: hostSnapshot }, "*");
            }
            pairIfReady();
        } else if (d.type === "host-snapshot") {
            hostSnapshot = d.snap;   // heartbeat — keep the freshest authoritative state
        } else if (d.type === "client-ready" && d.role) {
            clientReady.add(d.role);
            // Wait until EVERY box's renderer is up before collapsing the start-minimized ones.
            if (clientReady.size >= boxes.length) {
                for (const minimize of minimizeWhenReady) minimize();
            }
        }
    });

    function pairIfReady(): void {
        const host = boxesByRole.get("host"), peer = boxesByRole.get("peer");
        if (!host || !peer) return;
        // Host dials the current guest. Re-sent on any (re)announce → reconnect after a box reloads.
        host.win.postMessage({ type: "connect", targetId: peer.id } satisfies ConnectMsg, "*");
        log(`pair → host dials guest (${peer.id})`, "ok");
    }

    // ── Authority move (2-box dev convenience) ────────────────────────────────────
    // Move the authoritative referee to a chosen box so you can safely background / pop-out the OTHER
    // one (a peer just reconciles when it comes back; the host is the sim clock, so backgrounding it
    // would stall everything). NOT host migration — that's the N≥3 "a player dropped" case (deferred,
    // see games/war2/docs/box-reconnection.md). Here it's a manual swap of two boxes' roles.
    //
    // Implementation reuses everything reconnection already does: flip each box's role and reload it
    // under the new `?role`, so it spawns the right worker (referee vs thin client) and re-announces.
    // The box becoming host re-announces as host → the peer-ready handler above replays the latest
    // heartbeat as `restore`, so the new referee resumes the exact sim instead of reseeding; the
    // now-peer box reconciles against it. A ≤SNAPSHOT_MS blip, same character as a pop-out.
    //
    // Exposed as `swapHost()` on the return (war2 stashes it on `window` for console use) — a dev
    // affordance, deliberately NOT a permanent button in the window UI.
    interface BoxRuntime {
        config: BoxConfig;
        iframe: HTMLIFrameElement;
        currentRole: "host" | "peer";   // mutable; diverges from config.role after a swap
        setMinimized?: (m: boolean) => void;
    }
    const runtimes: BoxRuntime[] = [];

    function makeHost(target: BoxRuntime): void {
        if (target.currentRole === "host") return;   // already the authority
        // Promote brings it forward — booting a referee while minimized (display:none) inits at 0×0.
        target.setMinimized?.(false);
        for (const rt of runtimes) {
            rt.currentRole = rt === target ? "host" : "peer";
            // Reload under the new role: spawns the matching worker and re-announces → restore + re-pair.
            rt.iframe.src = `__virtual__/${rt.config.port}/${clientUrl}?role=${rt.currentRole}`;
        }
        log(`authority → ${target.config.label}`, "ok");
    }

    /** Move the authoritative referee to whichever box is currently the peer (the 2-box swap). */
    function swapHost(): void {
        const peer = runtimes.find((rt) => rt.currentRole === "peer");
        if (peer) makeHost(peer);
        else log("swapHost: no peer box to promote", "info");
    }

    // ── Boot: a box + client preview per BoxConfig ────────────────────────────────
    async function boot(): Promise<BoxHandle[]> {
        const handles: BoxHandle[] = [];
        try {
            const bridge = getServerBridge();
            await bridge.initServiceWorker();
            log("service worker ready", "ok");

            let windowOffset = 0;
            for (const box of boxes) {
                const vfs = new VirtualFS();
                bridge.registerServer(new GameProxyServer(vfs, { port: box.port }), box.port);

                const iframe = document.createElement("iframe");
                // Load the client UNDER the box's virtual prefix so its requests route through this
                // box (proxy/override). `?role` lets the box know its role from the URL alone, so it's
                // still pairable after being reloaded into a popped-out tab (its own top-level page).
                iframe.src = `__virtual__/${box.port}/${clientUrl}?role=${box.role}`;

                // Track this box's live role so the authority-move (makeHost) can swap it. config.role
                // is the initial role only; currentRole diverges once authority is moved.
                const rt: BoxRuntime = { config: box, iframe, currentRole: box.role };
                runtimes.push(rt);

                // `post` relays messages into the box (e.g. step-debugger control). Target the box's
                // CURRENT window (tracked per role from peer-ready) so it follows a popped-out box;
                // fall back to the in-page iframe before the first announce.
                handles.push({ port: box.port, role: box.role, vfs, post: (m) => (boxesByRole.get(box.role)?.win ?? iframe.contentWindow)?.postMessage(m, "*") });

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
                    rt.setMinimized = (m) => { minimized = m; draw(); };
                    draw();
                    // Defer minimize until every box has booted (client-ready) — booting
                    // while minimized (display:none) would init the canvas at 0×0.
                    if (box.startMinimized) minimizeWhenReady.push(() => rt.setMinimized!(true));
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

                // Role no longer needs a window→role map — each box announces its own role (from its
                // URL), so pairing is keyed by the announced role and survives a reload into a tab.
                log(`box ${box.port} (${box.role})${box.windowed ? " [windowed]" : ""} → /__virtual__/${box.port}/${clientUrl}`, "ok");
            }
        } catch (err) {
            log(`BOOT FAILED: ${(err as Error)?.stack ?? err}`, "err");
        }
        return handles;
    }

    log("almostnode: starting boxes…");
    return { boxes: await boot(), swapHost };
}
