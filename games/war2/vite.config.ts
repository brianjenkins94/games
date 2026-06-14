import { defineConfig } from "vite";
import { almostnodePlugin } from "almostnode/vite";
import { harnessPlugin } from "harness/vite";

export default defineConfig({
    // src/index.tsx composes the harness shell as JSX; render it via jsx-async-runtime.
    "esbuild": {
        "jsx": "automatic",
        "jsxImportSource": "jsx-async-runtime",
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
    ]
});
