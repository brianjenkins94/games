import { defineConfig } from "vite";

/**
 * Library build for the harness's browser-side runtime → dist/client.js. `client.ts` pulls
 * in the JSX shell (Harness.tsx), so the whole rendered harness is one compiled module and
 * consumers (which resolve `harness/client` → dist/client.js via package `exports`) need no
 * jsx-async-runtime toolchain — it lives here.
 *
 * `vite.ts` is deliberately NOT built: it's a node-side Vite plugin consumed at config-eval
 * time, so its `exports` entry points straight at the TypeScript source.
 */
export default defineConfig({
    "esbuild": {
        "jsx": "automatic",
        "jsxImportSource": "jsx-async-runtime",
    },
    "build": {
        "outDir": "dist",
        "lib": {
            "entry": { "client": "client.ts" },
            "formats": ["es"],
        },
        "rollupOptions": {
            // Leave deps unbundled — the consuming game's build resolves them from root.
            "external": [/^almostnode/, /^jsx-async-runtime/],
        },
    },
});
