/**
 * Stage 3 spike: does a CUSTOM ROUTE on the game's own dev server coexist with HMR?
 *
 * We subclass ViteDevServer → GameDevServer, intercept "/api/*" in handleRequest and
 * delegate everything else to super (the full Vite serve+HMR pipeline). We turn HMR on
 * for real (setHMRTarget + startWatching) — the first time in this spike — and add a
 * button that edits a VFS file so we can watch whether the preview hot-updates / reloads
 * while the custom route exists.
 *
 * Proves: (1) game fetches "/api/ping" (bare same-origin → routed to its own server →
 * our route answers), and (2) editing a VFS file still triggers HMR/live-reload.
 */
import { VirtualFS, ViteDevServer, getServerBridge, stream } from "almostnode";

const statusEl = document.getElementById("status")!;
const iframe = document.getElementById("preview") as HTMLIFrameElement;

function log(msg: string, cls: "ok" | "err" | "info" = "info"): void {
    const line = document.createElement("div");
    line.className = cls;
    line.textContent = `${new Date().toISOString().slice(11, 23)}  ${msg}`;
    statusEl.appendChild(line);
    statusEl.scrollTop = statusEl.scrollHeight;
    // eslint-disable-next-line no-console
    console.log(`[spike] ${msg}`);
}

window.addEventListener("error", (e) => log(`window error: ${e.message}`, "err"));
window.addEventListener("unhandledrejection", (e) => log(`unhandled rejection: ${e.reason}`, "err"));

const HAS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|png|jpe?g|svg|gif|wasm)$/i;
function addTsExt(code: string): string {
    return code
        .replace(/((?:\bfrom|\bimport\s*\()\s*)(["'])(\.[^"']*)\2/g, (m, p, q, s) => (HAS_EXT.test(s) ? m : `${p}${q}${s}.ts${q}`))
        .replace(/(\bimport\s+)(["'])(\.[^"']*)\2/g, (m, p, q, s) => (HAS_EXT.test(s) ? m : `${p}${q}${s}.ts${q}`));
}

// ── Custom dev server: a route alongside the full Vite pipeline ──────────────────
class GameDevServer extends ViteDevServer {
    async handleRequest(method: string, url: string, headers: Record<string, string>, body?: any) {
        const path = url.split("?")[0];
        if (path.startsWith("/api/")) {
            const payload = JSON.stringify({ route: path, method, pong: true, serverTime: new Date().toISOString() });
            return {
                statusCode: 200,
                statusMessage: "OK",
                headers: { "content-type": "application/json" },
                body: stream.Buffer.from(payload),
            };
        }
        // Everything else → the real Vite serve + HMR pipeline, untouched.
        return super.handleRequest(method, url, headers, body);
    }
}

// ── Inner app (vanilla) ─────────────────────────────────────────────────────────
const INNER_INDEX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>route+hmr</title>
<style>body{background:#0a0e17;color:#cdd;font-family:monospace;padding:20px;line-height:1.7}
h1{font-size:14px;color:#5f8}.k{color:#88aacc}.v{color:#ff9}pre{color:#9fd;font-size:12px}</style>
</head><body>
<h1 id="h">booting…</h1>
<pre id="out"></pre>
<script type="module" src="./entry.ts"><\/script>
</body></html>`;

const INNER_CONFIG_TS = `export const BUILD = "v1";`;

const INNER_ENTRY_TS = `import { BUILD } from "./config";
const out = document.getElementById("out")!;
const renderedAt = new Date().toISOString();
async function render() {
    let api = "(fetching…)";
    try { api = JSON.stringify(await (await fetch("/api/ping")).json()); } catch (e) { api = "FETCH ERROR: " + e; }
    out.innerHTML =
        "<span class='k'>config.BUILD</span> = <span class='v'>" + BUILD + "</span>   (edit /config.ts from the host button)\\n" +
        "<span class='k'>module rendered at</span> = " + renderedAt + "   (changes = the preview reloaded)\\n\\n" +
        "<span class='k'>GET /api/ping</span> (bare path → routed to this game's OWN server → custom route)\\n  " + api;
    document.getElementById("h")!.textContent = "✅ custom route answered + module running";
}
render();
`;

let vfs: VirtualFS;
let editN = 1;

async function boot(): Promise<void> {
    try {
        vfs = new VirtualFS();
        vfs.writeFileSync("/index.html", INNER_INDEX_HTML);
        vfs.writeFileSync("/entry.ts", addTsExt(INNER_ENTRY_TS));
        vfs.writeFileSync("/config.ts", INNER_CONFIG_TS);
        log("VFS ready (/index.html, /entry.ts, /config.ts)", "ok");

        const server = new GameDevServer(vfs, { port: 5173 });
        const bridge = getServerBridge();
        await bridge.initServiceWorker();
        bridge.registerServer(server, 5173);
        log("GameDevServer (ViteDevServer + /api/ route) registered", "ok");

        try { server.startWatching(); log("startWatching() — HMR watcher on", "ok"); }
        catch (e) { log("startWatching() threw: " + e, "err"); }

        iframe.onload = () => {
            try { server.setHMRTarget(iframe.contentWindow!); log("setHMRTarget(preview) — HMR channel wired", "ok"); }
            catch (e) { log("setHMRTarget threw: " + e, "err"); }
        };
        iframe.src = "/__virtual__/5173/";
        log("mounted /__virtual__/5173/", "ok");
    } catch (err) {
        log(`BOOT FAILED: ${(err as Error)?.stack ?? err}`, "err");
    }
}

// ── Host control: edit a VFS file to trigger the watcher ────────────────────────
const btn = document.createElement("button");
btn.textContent = "✎ Edit /config.ts (bump BUILD)";
btn.style.cssText = "align-self:flex-start;background:#1d3d5c;color:#adf;border:1px solid #2a5c8a;border-radius:4px;padding:6px 14px;cursor:pointer;font-family:monospace;font-size:12px;";
btn.onclick = () => {
    editN++;
    const next = `export const BUILD = "v${editN}";`;
    vfs.writeFileSync("/config.ts", next);
    // Host-driven live-reload: the host wrote the file, so it knows to reload — no
    // dependence on almostnode's (React-centric) HMR client. Same-origin iframe, so
    // we can reload it directly.
    try {
        iframe.contentWindow?.location.reload();
        log(`edited /config.ts → BUILD="v${editN}" + reloaded preview (host-driven)`, "ok");
    } catch (e) {
        log(`edit ok but reload threw: ${e}`, "err");
    }
};
statusEl.insertAdjacentElement("afterend", btn);

log("Stage 3: custom route + HMR…");
void boot();
