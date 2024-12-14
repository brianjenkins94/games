// @ts-expect-error
import type { BuildOptions, Format, Options } from "tsup";
import { defineConfig } from "tsup";
import * as path from "path";
import * as url from "url";
import * as fs from "fs/promises";

function esbuildOptions(overrides: BuildOptions = {}) {
	overrides["assetNames"] ??= "assets/[name]";
	overrides["chunkNames"] ??= "assets/[name]-[hash]";
	overrides["entryNames"] ??= "[dir]/[name]";

	return function(options: BuildOptions, context: { "format": Format }) {
		for (const [key, value] of Object.entries(overrides)) {
			options[key] = value;
		}
	};
}

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
    "entry": {
       "game": path.join(__dirname, "game.ts"),
       "GridEngine": path.join(__dirname, "..", "..", "util", "phaser", "grid-engine", "src", "GridEngine.ts")
    },
    "esbuildOptions": esbuildOptions({
        "outdir": path.join(__dirname, "dist")
    }),
    "esbuildPlugins": [],
    "external": ["phaser"],
    "onSuccess": async function() {
        const file = path.join(__dirname, "dist", "game.js");

        const replacementMap = {
            "phaser": "Phaser"
        };

        const importRegex = new RegExp(`^import(?:\\* as )? (.*?) from (?:'|")(${Object.keys(replacementMap).join("|")})(?:'|");$` ,"gmu");

        await fs.writeFile(file, (await fs.readFile(file, { "encoding": "utf8" })).replace(importRegex, function(_, ...matches) {
            return `const ${matches[0]} = ${replacementMap[matches[1]]};`;
        }))
    }
});
