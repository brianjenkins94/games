import { defineConfig } from "vite";
import { almostnodePlugin } from "almostnode/vite";
import { harnessPlugin } from "harness/vite";
import { vscodePlugin } from "vscode/vite";

export default defineConfig({
    // src/index.tsx composes the harness shell as JSX; render it via jsx-async-runtime.
    "esbuild": {
        "jsx": "automatic",
        "jsxImportSource": "jsx-async-runtime",
    },
    // Force a single Preact instance across chunks. The workspace packages (window/theme/vscode)
    // each import Preact through their *own* pnpm symlink path, so without this Vite bundles a
    // separate copy per chunk — and the lazily-imported `vscode` chunk's VtWindow ends up calling
    // hooks against a different Preact than the one that rendered it ("Cannot read … '__H'" /
    // null currentComponent). Deduping collapses them to one resolved module → one instance.
    "resolve": {
        "dedupe": ["preact", "preact/hooks", "preact/jsx-runtime", "preact/compat"],
    },
    // `vscode` is a linked source package loaded via a *dynamic* import (lazy, post-isolation).
    // Vite auto-excludes statically-imported linked packages from pre-bundling but not dynamic
    // ones, so without this the optimizer tries to pre-bundle it and resolve its dep `window`
    // from war2's root (where it doesn't live), aborting the scan. Exclude both so they're
    // transformed as source and their imports resolve from the package's own node_modules.
    "optimizeDeps": {
        "exclude": ["vscode", "window", "theme"],
    },
    "experimental": {
        "renderBuiltUrl": function(filename, { type }) {
            // Static assets live in the separate assets repo at /assets/war2/ (out of the SW's
            // scope, so they load directly, bypassing the boxes). JS/CSS chunks are the app
            // itself — leave them base-relative.
            if (type === "asset" && !/\.(?:js|css)$/.test(filename)) {
                return `/assets/war2/${filename.replace(/^assets\//, "")}`;
            }
            return undefined;
        },
    },
    "plugins": [
        // Cross-origin-isolate the *host* page so the VS Code workbench iframe can use
        // SharedArrayBuffer (an iframe is only isolated if its top-level page is). almostnode's
        // SW isolates the `__virtual__/<port>/` boxes but deliberately not the host. We set the
        // headers via middleware (not `server.headers`) because the dev server serves index.html
        // through a manual fallback that bypasses `server.headers`; a configureServer middleware
        // runs earlier in the chain so the headers persist onto that response. `credentialless`
        // keeps cross-origin CDN/font subresources working without requiring CORP on them.
        {
            "name": "coi-headers",
            "configureServer": function(server) {
                server.middlewares.use(function(_req, res, next) {
                    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
                    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
                    next();
                });
            },
        },
        almostnodePlugin(),
        {
            "name": "external-assets",
            "generateBundle": function(options, bundle) {
                for (const key of Object.keys(bundle)) {
                    // Externalise only *real* static assets (images/json/etc.), which
                    // ship from the separate assets repo. Keep emitted JS/CSS — notably
                    // module-worker chunks (referee/client.worker), which Vite emits as
                    // `type: "asset"` but are app code that must be written to disk.
                    // Mirrors the `renderBuiltUrl` filter above.
                    if (bundle[key].type === "asset" && !/\.(?:js|css)$/.test(key)) {
                        delete bundle[key];
                    }
                }
            }
        },
        // Deploy-time SW patch for the almostnode sub-path (CI only; no-ops in dev).
        harnessPlugin(),
        // Serves the monaco-vscode-api workbench (host page + dist) at /__vscode__/. MUST be last:
        // its generateBundle emits the dist's wasm/font assets *after* the external-assets plugin
        // above has run, so they aren't stripped as "external" static assets.
        vscodePlugin(),
    ]
});
