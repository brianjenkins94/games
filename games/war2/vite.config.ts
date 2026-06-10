import { defineConfig } from "vite";
import { almostnodePlugin } from "almostnode/vite";
import { fileURLToPath } from "node:url";
// The harness is a sibling source package, not an installed dependency: import the node-side
// plugin straight from source, and alias the browser runtime to its built output (below).
import { harnessPlugin } from "../../packages/harness/vite";

export default defineConfig({
    "resolve": {
        "alias": {
            // war2 consumes the pre-built harness (JSX already compiled with jsx-async-runtime),
            // so war2 itself needs no JSX toolchain. Built by war2's `build` script beforehand.
            "harness/client": fileURLToPath(new URL("../../packages/harness/dist/client.js", import.meta.url)),
        },
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
                    if (bundle[key].type === "asset") {
                        delete bundle[key];
                    }
                }
            }
        },
        // Deploy-time SW patch for the almostnode sub-path (CI only; no-ops in dev).
        harnessPlugin(),
    ]
});
