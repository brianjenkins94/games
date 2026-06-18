/**
 * Per-package build convention — thin wrapper over the published @brianjenkins94/util.
 *
 * A package opts in by pointing its own `build` script here (`tsx ../../util/vite/build.ts`);
 * this delegates to the shared `buildApp`, passing the games-specific deviations: a
 * `/games/<name>/` deploy base and the shared phaser shim aliased onto the bare `phaser`
 * specifier (Phaser loads via a CDN <script>, so it is never bundled).
 *
 * The build behaviour (app vs library detection, injected defaults, asset layout) lives in
 * `@brianjenkins94/util/vite/build`; this file only supplies the games-specific options.
 */
import { buildApp } from "@brianjenkins94/util/vite/build";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export { buildApp };

// Run directly → build the package this was invoked from. repoRoot is two levels
// up from this file (util/vite/).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const repoRoot = resolve(import.meta.dirname, "../..");

    await buildApp(process.cwd(), repoRoot, {
        baseDir: "games",
        overrides: {
            resolve: { alias: { phaser: resolve(repoRoot, "util/vite/phaser-shim.ts") } }
        }
    });
}
