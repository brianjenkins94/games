/**
 * war2 host entry — renders the reusable harness shell as JSX, then wires its runtime
 * (boxes + peer pairing) onto the mounted markup. The `<Harness/>` call is why this file
 * is .tsx: war2's esbuild is configured for jsx-async-runtime (see vite.config.ts).
 */
import { jsxToString } from "jsx-async-runtime";
import { Harness, wireHarness, type BoxConfig } from "harness/client";
import { mountMetrics } from "metrics";
import { forwardMetricsToDebug } from "./debug/metricsForward";
// `import.meta.glob` excludes the globbing file itself, so pull this entry's source in directly.
import indexRaw from "./index.tsx?raw";

// One virtual port per box (distinct from the real outer 5173).
const boxes: BoxConfig[] = [
    // Both boxes run in floating windows.  The host stays open; the peer starts
    // minimized once both have initialized — available for debugging, out of the way.
    // Roles are the INITIAL assignment; `swapHost()` in the console moves the authoritative
    // referee between boxes at runtime (so you can background/pop-out the non-host one).
    { port: 5273, role: "host", label: "BOX A · host", windowed: true },
    { port: 5274, role: "peer", label: "BOX B · peer", windowed: true, startMinimized: true },
];

// Bring host subsystems online one at a time, each isolated: log when it's up, and if it throws,
// log it and carry on rather than aborting the whole boot. A flat chain of top-level `await`s would
// otherwise hang the page's DOMContentLoaded on any single failure, and give no signal as to which
// subsystem broke (that's exactly what made the assets-provider crash so hard to localize).
async function stage<T>(name: string, fn: () => T | Promise<T>): Promise<T | undefined> {
    const t0 = performance.now();
    try {
        const result = await fn();
        console.info(`[boot] ${name} ✓ ${Math.round(performance.now() - t0)}ms`);
        return result;
    } catch (error) {
        console.error(`[boot] ${name} ✗ — continuing without it`, error);
        return undefined;
    }
}

/** Race a readiness signal against a timeout, so a subsystem that comes up but never confirms it's
 *  actually online (rendered/paired) surfaces as a failed stage instead of silently half-working. */
function online(signal: Promise<unknown>, timeoutMs: number, label: string): Promise<void> {
    return Promise.race([
        signal.then(() => undefined),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} within ${timeoutMs}ms`)), timeoutMs)),
    ]);
}

// Boxes confirm readiness by posting "client-ready" once their renderer is up. Listen from the start
// (before they're created) so no early signal is missed; a stage below awaits both.
let boxesReadyCount = 0;
const boxesReady = new Promise<void>((resolve) => {
    window.addEventListener("message", (event) => {
        if ((event.data as { type?: string } | null)?.type === "client-ready" && ++boxesReadyCount >= boxes.length) resolve();
    });
});

/** Post-boot health: subsystem *liveness*. Each box streams perf samples ~4Hz; if one falls silent
 *  after having been alive, it has hung or crashed — warn. This is the in-page health signal that's
 *  actually reliable.
 *
 *  NOTE on memory leaks: detecting a runaway like the assets-provider one from in-page JS is *not*
 *  viable — `performance.memory` is per-context (blind to the workbench iframe's heap, where that
 *  leak lived) and `measureUserAgentSpecificMemory` is throttled so hard it returns nothing useful
 *  before an OOM. That class is caught with the dev DevTools/CDP heap (how this one was found) and
 *  localized with the staged boot above. */
function startHealthHeartbeat(): void {
    const lastSeen = new Map<string, number>();
    window.addEventListener("message", (event) => {
        const d = event.data as { type?: string; role?: string } | null;
        if (d?.type === "metrics" && typeof d.role === "string") lastSeen.set(d.role, performance.now());
    });
    const warned = new Set<string>();
    setInterval(() => {
        const now = performance.now();
        for (const box of boxes) {
            const seen = lastSeen.get(box.role);
            if (seen == null) continue;                       // never started → boxes-ready stage's job
            const silentMs = now - seen;
            if (silentMs > 10000 && !warned.has(box.role)) { warned.add(box.role); console.warn(`[health] box "${box.role}" silent ${Math.round(silentMs / 1000)}s — hung or crashed?`); }
            else if (silentMs < 10000) warned.delete(box.role);   // recovered
        }
    }, 5000);
}

const app = document.getElementById("app")!;

await stage("shell", async () => { app.innerHTML = await jsxToString.call({}, <Harness />); });

const harness = await stage("harness", () => wireHarness(app, { clientUrl: "client.html", boxes }));
const boxHandles = harness?.boxes ?? [];
// Dev affordance: move the authoritative referee to the other box from the console (so you can
// safely background / pop-out the non-host one). Deliberately not surfaced in the window UI.
if (harness) (globalThis as { swapHost?: () => void }).swapHost = harness.swapHost;

// Confirm the boxes actually came online (paired + rendered), not just that wireHarness returned.
await stage("boxes-ready", () => online(boxesReady, 15000, "boxes did not report ready"));

// Cross-origin isolation for the *host* page. In dev a Vite middleware sets COOP/COEP directly on
// the navigation; in a static deploy (GitHub Pages) it can't, so the page starts non-isolated. The
// almostnode SW — patched at deploy time (see harnessPlugin) — re-serves same-origin navigations
// with those headers once it controls the page, but only a fresh navigation picks them up. So if
// we're controlled yet still not isolated, reload once (sessionStorage-guarded against a loop).
if (!crossOriginIsolated && navigator.serviceWorker?.controller && !sessionStorage.getItem("coi-reload")) {
    sessionStorage.setItem("coi-reload", "1");
    location.reload();
}

// Realtime perf dashboard — each box's client shell forwards perf samples here via
// postMessage; mountMetrics charts host vs guest (fps, sim tick, latency, wire).
const metrics = document.createElement("div");
app.appendChild(metrics);
await stage("metrics", () => mountMetrics(metrics));

// Mirror the same samples onto the debug WS so the MCP inspector can query perf (dev only).
await stage("metrics-debug", () => forwardMetricsToDebug());

// Floating VS Code workbench — lazy-loaded only once the page is cross-origin isolated, since the
// workbench iframe needs SharedArrayBuffer. Isolation comes from COOP/COEP on the host navigation
// (a Vite middleware in dev; the deploy-patched SW + the one-time reload above in prod).
if (crossOriginIsolated) await stage("workbench", async () => {
    const { createVscodeWindow } = await import("vscode");

    // This game's own source — shown/edited in the workbench. Raw text, bundled at build.
    // Two patterns: `**/*` only matches nested files, so `*` is needed for root-level ones.
    const rawSources = {
        "./index.tsx": indexRaw,
        ...import.meta.glob("./*.{ts,tsx,js,jsx,json,css,html,md,glsl,vert,frag,wgsl}", { query: "?raw", import: "default", eager: true }),
        ...import.meta.glob("./**/*.{ts,tsx,js,jsx,json,css,html,md,glsl,vert,frag,wgsl}", { query: "?raw", import: "default", eager: true }),
    } as Record<string, string>;
    // The workbench opens a single folder "war2" whose root *is* this game's src/ — so files
    // appear directly under it (e.g. war2/render/…), not nested under a src/ node.
    const files: { path: string; contents: string; readonly?: boolean }[] = Object.entries(rawSources).map(([key, contents]) => ({
        path: "/war2/" + key.replace(/^\.\//u, ""),
        contents,
    }));

    // The workspace-linked packages aren't on the CDN, so bundle their source under node_modules
    // (npm deps come from unpkg via `moduleVersions`). Excludes their own node_modules/dist.
    const workspaceSources = import.meta.glob([
        "../../../packages/{harness,metrics,window,theme,vscode}/**/*.{ts,tsx,json}",
        "!**/node_modules/**",
        "!**/dist/**",
    ], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const [key, contents] of Object.entries(workspaceSources)) {
        // node_modules snapshot — read-only/undeletable (a seeded copy; edits wouldn't propagate).
        files.push({ path: "/war2/node_modules/" + key.replace(/^.*\/packages\//u, ""), contents, readonly: true });
    }

    // npm deps the *source* imports directly must resolve SYNChronously for the TS server — it
    // resolves package.json/exports against a synchronous worker view that the async CDN provider
    // can't populate (confirmed by experiment), so snapshot their types. Transitive deps (only
    // needed for go-to-definition, not type-checking) stay on the CDN.
    const npmTypeSources = import.meta.glob([
        "../node_modules/jsx-async-runtime/**/*.{ts,json}",
        "!**/node_modules/**/node_modules/**",
    ], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const [key, contents] of Object.entries(npmTypeSources)) {
        files.push({ path: "/war2/node_modules/" + key.replace(/^.*\/node_modules\//u, ""), contents, readonly: true });
    }


    // Ambient types so the workbench's TS understands vite's import.meta.glob + `?raw`/`?url`
    // module queries (it has no vite/client types), silencing those as unresolved.
    files.push({
        path: "/war2/vite-env.d.ts",
        readonly: true,
        contents:
            `interface ImportMeta { glob: (pattern: string | string[], options?: Record<string, unknown>) => Record<string, unknown>; readonly env: { readonly PROD: boolean; readonly DEV: boolean; readonly BASE_URL: string; readonly [key: string]: unknown }; }\n` +
            `declare module "*?raw" { const content: string; export default content; }\n` +
            `declare module "*?import&raw" { const content: string; export default content; }\n` +
            `declare module "*?url" { const content: string; export default content; }\n`,
    });

    // Seed a launch.json for the step debugger. The "war2-sim" debugger contributes no language
    // association (it attaches to the running sim, not a file), so VS Code's file-inferred entry
    // points ("Run and Debug", "Add Configuration") never offer it — a committed config is what puts
    // "war2 sim" in the Run & Debug dropdown so F5 starts the session.
    files.push({
        path: "/war2/.vscode/launch.json",
        readonly: true,
        contents: JSON.stringify({
            version: "0.2.0",
            configurations: [{ name: "war2 sim", type: "war2-sim", request: "attach" }],
        }, null, 2),
    });

    // Workspace tsconfig so the editor's TS server uses the right JSX runtime + module resolution
    // and picks up vite-env.d.ts (war2's real tsconfig sits above this src-as-root, out of view).
    files.push({
        path: "/war2/tsconfig.json",
        readonly: true,
        contents: JSON.stringify({
            compilerOptions: {
                target: "esnext",
                module: "esnext",
                moduleResolution: "bundler",
                jsx: "react-jsx",
                jsxImportSource: "jsx-async-runtime",
                lib: ["esnext", "dom", "dom.iterable"],
                allowImportingTsExtensions: true,
                noEmit: true,
                types: [],
            },
        }, null, 2),
    });

    // npm deps resolve from unpkg, but *only* ones pinned here: unpkg redirects unversioned requests
    // and the redirect lacks CORS headers, so unpinned packages can't be fetched (they're skipped, no
    // console noise). Inlined rather than read from package.json, which would escape /war2 in-editor.
    const moduleVersions: Record<string, string> = { "jsx-async-runtime": "2.1.2" };

    // Save → write into the host box's VirtualFS (path as the box serves it, /src/…) so the
    // running game picks up the edit (the GameProxyServer serves VFS entries over the proxy).
    const hostBox = boxHandles.find((box) => box.role === "host");
    // The guest box predicts ahead of the referee; freeze it whenever the host sim is halted so it
    // doesn't rubber-band while we pause/step/reverse, and free it again on continue.
    const peerBox = boxHandles.find((box) => box.role === "peer");

    const vscodeWindow = createVscodeWindow({
        files,
        workspaceFolder: "/war2",
        moduleVersions,
        // Static assets overlay: same-origin in prod (Pages, /assets/war2/) and dev (src/assets).
        // Both carry a tree.txt index generated by postinstall.sh (the overlay enumerates from it).
        assetsBase: import.meta.env.PROD ? "/assets/war2/" : "/src/assets/",
        openEditors: files.filter((file) => /\/war2\/index\.(ts|tsx)$/u.test(file.path)).map((file) => file.path).slice(0, 1),
        onSave: (path, contents) => {
            hostBox?.vfs.writeFileSync(path.replace(/^\/war2/u, "/src"), contents);
        },
        // Step debugger: the workbench's DAP adapter drives the *authoritative* host box's sim.
        onDebugControl: (msg) => {
            hostBox?.post({ type: "sim-debug-control", msg });
            // Continue frees the guest to predict again; the host's "stopped" events re-freeze it.
            if ((msg as { kind?: string } | null)?.kind === "resume") peerBox?.post({ type: "sim-debug-control", msg: { kind: "resume" } });
        },
    });

    // …and the host box's sim halts/state flow back into the workbench's adapter.
    window.addEventListener("message", (event) => {
        const data = event.data as { type?: string; msg?: { kind?: string } } | null;
        if (data?.type !== "sim-debug-event") return;
        vscodeWindow.sendDebugEvent(data.msg);
        // Any halt of the authoritative sim freezes the guest so it can't run ahead.
        if (data.msg?.kind === "stopped") peerBox?.post({ type: "sim-debug-control", msg: { kind: "pause" } });
    });

    // Confirm the workbench actually booted (monaco mounted), not just that the iframe was created.
    await online(vscodeWindow.whenReady, 30000, "workbench did not boot");
});

// Post-boot health monitor — warns if a box that was alive goes silent (hung/crashed).
await stage("health", () => startHealthHeartbeat());
