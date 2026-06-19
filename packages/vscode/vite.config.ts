import { defineConfig } from "vite";

/**
 * Builds the iframe entry (workbench-entry.tsx → dist/workbench.js) that renders the game-composed
 * <Workbench/> and boots monaco. Lib's pre-built bundle is kept external and mapped to the sibling
 * `./main.js` (served alongside by vite.ts), so it isn't re-bundled into this small entry.
 */
export default defineConfig({
	"esbuild": {
		"jsx": "automatic",
		"jsxImportSource": "preact"
	},
	"build": {
		"target": "esnext",
		"outDir": "dist",
		"emptyOutDir": true,
		"minify": true,
		"rollupOptions": {
			"input": { "workbench": "workbench-entry.tsx" },
			"external": ["@brianjenkins94/monaco-vscode-api/main"],
			"output": {
				"format": "es",
				"entryFileNames": "[name].js",
				"chunkFileNames": "[name].js",
				"paths": { "@brianjenkins94/monaco-vscode-api/main": "./main.js" }
			}
		}
	}
});
