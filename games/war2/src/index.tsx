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
    { port: 5273, role: "host", label: "BOX A · host", windowed: true },
    { port: 5274, role: "peer", label: "BOX B · peer", windowed: true, startMinimized: true },
];

const app = document.getElementById("app")!;
app.innerHTML = await jsxToString.call({}, <Harness />);
const { boxes: boxHandles } = await wireHarness(app, { clientUrl: "client.html", boxes });

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
mountMetrics(metrics);

// Mirror the same samples onto the debug WS so the MCP inspector can query perf (dev only).
forwardMetricsToDebug();

// Floating VS Code workbench — lazy-loaded only once the page is cross-origin isolated, since the
// workbench iframe needs SharedArrayBuffer. Isolation comes from COOP/COEP on the host navigation
// (a Vite middleware in dev; the deploy-patched SW + the one-time reload above in prod).
if (crossOriginIsolated) {
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
    const hostVfs = boxHandles.find((box) => box.role === "host")?.vfs;

    createVscodeWindow({
        files,
        workspaceFolder: "/war2",
        moduleVersions,
        // Static assets: same-origin in prod (Pages) and dev (war2 serves the local clone).
        assetsBase: import.meta.env.PROD ? "/assets/war2/" : "/src/assets/",
        openEditors: files.filter((file) => /\/war2\/index\.(ts|tsx)$/u.test(file.path)).map((file) => file.path).slice(0, 1),
        onSave: (path, contents) => {
            hostVfs?.writeFileSync(path.replace(/^\/war2/u, "/src"), contents);
        },
    });
}
