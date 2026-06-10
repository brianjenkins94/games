/**
 * Per-package static build for GitHub Pages.
 *
 * A package opts in by pointing its own `build` script here
 * (`tsx ../../util/vite/build.ts`); this builds *that* package (its cwd) — there
 * is no build-everything entry. Vite config is supplied inline (shared
 * phaser-shim alias, `/games/<name>/` base), so a package only needs its own
 * vite.config to deviate. Output: `docs/<name>/`.
 */
import { build } from "vite";
import { readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

/** Build one game directory → `<repoRoot>/docs/<name>/`. */
export async function buildApp(appRoot: string, repoRoot: string): Promise<void> {
    const name  = basename(appRoot);
    const input = readdirSync(appRoot)
        .filter((f) => f.endsWith(".html"))
        .map((f) => resolve(appRoot, f));

    await build({
        root: appRoot,
        base: `/games/${name}/`,
        logLevel: "warn",
        // Phaser loads via a CDN <script>; alias it to the shared shim (the global)
        // instead of bundling. A game adds its own vite.config only to deviate.
        resolve: { alias: { phaser: resolve(repoRoot, "util/vite/phaser-shim.ts") } },
        build: {
            outDir: resolve(repoRoot, "docs", name),
            assetsInlineLimit: 0,
            minify: false,
            modulePreload: { polyfill: false },
            rollupOptions: {
                input,
                output: {
                    entryFileNames: "[name].js",
                    chunkFileNames: "[name].js",
                    // Mirror each asset's on-disk location (strip the leading src/)
                    // instead of flattening into assets/. Fallback for generated assets.
                    assetFileNames: (asset) => {
                        const src = asset.originalFileName;
                        return src ? src.replace(/^src\//, "") : "assets/[name][extname]";
                    },
                },
            },
        },
    });
    console.log(`built ${name} → docs/${name}/`);
}

// Run directly → build the package this was invoked from. repoRoot is two levels
// up from this file (util/vite/).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    await buildApp(process.cwd(), resolve(import.meta.dirname, "../.."));
}
