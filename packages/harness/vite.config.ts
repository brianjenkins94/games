import { defineConfig } from "vite";

/**
 * Library build for the harness's browser-side runtime → dist/client.js. `client.ts` pulls
 * in the JSX shell (Harness.tsx), so the whole rendered harness is one compiled module and
 * consumers (which alias `harness/client` → dist/client.js) need no jsx-async-runtime
 * toolchain — it lives here.
 *
 * `vite.ts` is deliberately NOT built: it's a node-side Vite plugin consumed at config-eval
 * time, so consumers import it straight from TypeScript source.
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
            "entry": { "client": "client.ts" },
            "formats": ["es"],
        },
        "rollupOptions": {
            // Leave deps unbundled — the consuming game's build resolves them from root.
            "external": [/^almostnode/, /^jsx-async-runtime/],
            "output": { "entryFileNames": "[name].js", "chunkFileNames": "[name].js" },
        },
    },
});
