import { defineConfig } from "vite";

/**
 * Library build for the harness's browser-side runtime → dist/client.js. `client.ts`
 * re-exports the JSX shell (Harness.tsx) already compiled, so consumers (which resolve
 * `harness/client` → dist/client.js via package `exports`) get a ready-to-render `Harness`
 * component. A consumer that composes it in its own JSX still needs the jsx-async-runtime
 * toolchain (esbuild jsxImportSource) to emit the `<Harness/>` call itself.
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
            "entry": { "client": "client.tsx" },
            "formats": ["es"],
        },
        "rollupOptions": {
            // Leave deps unbundled — the consuming game's build resolves them from root.
            // (preact + @stitches/core + lucide arrive via the bundled `window` component.)
            "external": [/^almostnode/, /^jsx-async-runtime/, /^preact/, /^@stitches/, /^lucide/],
        },
    },
});
