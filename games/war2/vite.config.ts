import { defineConfig } from "vite";
import { almostnodePlugin } from "almostnode/vite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

export default defineConfig({
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
        // CI build only: make the two-box harness work under the deployed sub-path
        // (/games/war2/) without hardcoding that path anywhere — everything is derived.
        process.env.CI && {
            "name": "patch-almostnode-sw",
            // Relative base → the app's own resources resolve *under* the box's virtual prefix,
            // so the SW matches them directly (no referer-fallback) and the deploy path never
            // needs to be hardcoded.
            "config": function() { return { "base": "./" }; },
            "writeBundle": function(options) {
                const swSrc = url.fileURLToPath(new URL("__sw__.js", import.meta.resolve("almostnode")));
                const sw = fs.readFileSync(swSrc, "utf8")
                    // Un-anchor the matcher: match `__virtual__/<port>` anywhere in the path, so
                    // it works under any base without injecting the deploy path.
                    .split("^\\/__virtual__").join("\\/__virtual__")
                    // Drop the referer-fallback: with a relative base, in-app resources are
                    // matched directly, so it would only ever (wrongly) forward external requests
                    // (assets repo, CDNs). Disabling it lets those pass through to the network.
                    .replace("if (refererMatch) {", "if (false) {");
                fs.writeFileSync(path.join(options.dir, "__sw__.js"), sw);

                // almostnode hardcodes the SW path + scope at the origin root
                // (`register("/__sw__.js", { scope: "/" })`). Make both relative so it registers
                // under the app's own dir — a Pages sub-path can't grant root scope.
                const entry = path.join(options.dir, "index.js");
                fs.writeFileSync(entry, fs.readFileSync(entry, "utf8")
                    .replace('"/__sw__.js"', '"__sw__.js"')
                    .replace('scope: "/"', 'scope: "./"'));
            },
        }
    ]
});
