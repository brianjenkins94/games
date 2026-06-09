import { defineConfig } from "vite";
import { almostnodePlugin } from "almostnode/vite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

let swBase = "/";

export default defineConfig({
    "experimental": {
        "renderBuiltUrl": function(filename, { type }) {
            // Static assets are served from the separate assets repo at /assets/war2/
            // (out of the SW's /games/war2/ scope, so they load directly). JS/CSS chunks
            // are the app itself — leave them base-relative.
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
        // Emit a base-relative copy of almostnode's service worker. Its virtual-server
        // matchers are anchored at root (`/__virtual__/…`); rewrite them to the app
        // base (e.g. `/games/war2/__virtual__/…`) so the SW can be hosted and scoped
        // under the base instead of needing origin-root scope (impossible on a GitHub
        // Pages sub-path). Done in writeBundle so external-assets doesn't strip it.
        // Only the deployed CI build needs this; dev/local builds use root paths.
        process.env.CI && {
            "name": "patch-almostnode-sw",
            "configResolved": function(config) { swBase = config.base; },
            "writeBundle": function(options) {
                const swSrc = url.fileURLToPath(new URL("__sw__.js", import.meta.resolve("almostnode")));
                const seg = swBase.replace(/^\//, "").replace(/\//g, "\\/"); // "games\/war2\/"
                const sw = fs.readFileSync(swSrc, "utf8")
                    .split("\\/__virtual__\\/").join("\\/" + seg + "__virtual__\\/")
                    // The referer-fallback forwards *every* request from a boxed (controlled)
                    // client to the box — including external assets at /assets/war2/, which the
                    // box then base-prefixes into a 404. Only forward in-app paths; let the rest
                    // (assets repo, cross-origin CDNs) pass through to the network.
                    .replace("if (refererMatch) {", `if (refererMatch && url.pathname.startsWith("${swBase}")) {`);
                fs.writeFileSync(path.join(options.dir, "__sw__.js"), sw);

                // almostnode hardcodes the SW path + scope at the origin root
                // (`register("/__sw__.js", { scope: "/" })`). Make both relative so it
                // registers under the app base — a Pages sub-path can't grant root scope.
                const entry = path.join(options.dir, "index.js");
                fs.writeFileSync(entry, fs.readFileSync(entry, "utf8")
                    .replace('"/__sw__.js"', '"__sw__.js"')
                    .replace('scope: "/"', 'scope: "./"'));
            },
        }
    ]
});
