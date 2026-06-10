import { defineConfig } from "vite";

/**
 * Library build for the harness's browser-side modules (Harness.tsx + client.ts) → dist/.
 * Consumers get the pre-compiled JS (see `exports` in package.json), so they don't need to
 * know about the jsx-async-runtime JSX toolchain — it lives here.
 *
 * `vite.ts` is deliberately NOT built: it's a node-side Vite plugin consumed at config-eval
 * time, so its `./vite` export points straight at the TypeScript source.
 */
export default defineConfig({
    "esbuild": {
        "jsx": "automatic",
        "jsxImportSource": "jsx-async-runtime",
    },
    "build": {
        "outDir": "dist",
        // Overwrite in place rather than wiping the dir: `prepare` builds dist at install
        // time, and the root `pnpm run build` re-runs every package's `build` script in
        // parallel — emptying here would race a consuming game's build reading dist.
        "emptyOutDir": false,
        "minify": false,
        "target": "esnext",
        "lib": {
            "entry": { "Harness": "Harness.tsx", "client": "client.ts" },
            "formats": ["es"],
        },
        "rollupOptions": {
            // Leave deps unbundled — the consuming game's build resolves them from root.
            "external": [/^almostnode/, /^jsx-async-runtime/],
            "output": { "entryFileNames": "[name].js", "chunkFileNames": "[name].js" },
        },
    },
});
