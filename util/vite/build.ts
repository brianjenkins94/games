/**
 * Per-package static build.
 *
 * A package opts in by pointing its own `build` script here (`tsx ../../util/vite/build.ts`);
 * this builds *that* package (its cwd). The preferred build defaults (unminified, `[name].js`,
 * esnext, cleaned outDir) are injected by `buildPackage` from `@brianjenkins94/util/vite/build`.
 *
 * A package with `.html` entries is built as a GitHub Pages game app: deployed under a
 * `/games/<name>/` base to `docs/<name>/`, with the shared phaser shim and on-disk asset
 * layout. A package without `.html` (e.g. a library) is built purely from its own vite.config
 * (its `outDir`, `lib`, etc.), getting only the injected defaults on top.
 */
import { buildPackage } from "@brianjenkins94/util/vite/build";
import { readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

export async function buildApp(appRoot: string, repoRoot: string): Promise<void> {
    const name  = basename(appRoot);
    const input = readdirSync(appRoot)
        .filter((f) => f.endsWith(".html"))
        .map((f) => resolve(appRoot, f));
    const isApp = input.length > 0;

    await buildPackage(appRoot, isApp ? {
        base: `/games/${name}/`,
        // Phaser loads via a CDN <script>; alias it to the shared shim (the global)
        // instead of bundling. A game adds its own vite.config only to deviate.
        resolve: { alias: { phaser: resolve(repoRoot, "util/vite/phaser-shim.ts") } },
        build: {
            outDir: resolve(repoRoot, "docs", name),
            assetsInlineLimit: 0,
            modulePreload: { polyfill: false },
            rollupOptions: {
                input,
                output: {
                    // Mirror each asset's on-disk location (strip the leading src/)
                    // instead of flattening into assets/. Fallback for generated assets.
                    assetFileNames: (asset) => {
                        const src = asset.originalFileName;
                        return src ? src.replace(/^src\//, "") : "assets/[name][extname]";
                    },
                },
            },
        },
    } : {});

    console.log(`built ${name}${isApp ? ` → docs/${name}/` : ""}`);
}

// Run directly → build the package this was invoked from. repoRoot is two levels
// up from this file (util/vite/).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    await buildApp(process.cwd(), resolve(import.meta.dirname, "../.."));
}
