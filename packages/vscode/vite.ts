/**
 * Serves the VS Code workbench for the iframe in `vscode.tsx`.
 *
 * The iframe loads `<base>/__vscode__/host.html`, a minimal page that pulls in the game-composed
 * entry `workbench.js` (built from workbench-entry.tsx into this package's `dist/`), which renders
 * <Workbench/> and boots lib's `main.js`. So `/__vscode__/` is served from two roots: this
 * package's `dist/` (host entry) and the lib monaco package's `dist/` (main.js + chunks +
 * worker/wasm/font assets + monaco's own webview index.html). The host app supplies cross-origin
 * isolation (SharedArrayBuffer); this plugin only serves files (with COEP so the iframe inherits it).
 */
import type { Plugin } from "vite";
import { createRequire } from "node:module";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const MOUNT = "/__vscode__/";

// Minimal iframe host page: the grid/layout now lives in the <Workbench/> component (stitches),
// so this just resets the document and loads the game entry bundle.
const HOST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>monaco-vscode-api</title>
	<style>html, body { height: 100%; margin: 0; overflow: hidden; }</style>
</head>
<body>
	<script type="module" src="./workbench.js"></script>
</body>
</html>
`;

const CONTENT_TYPES: Record<string, string> = {
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".html": "text/html",
	".json": "application/json",
	".wasm": "application/wasm",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".png": "image/png",
	".svg": "image/svg+xml"
};

function libDistDirectory(): string {
	const require = createRequire(import.meta.url);
	// The package only exports "./main" (→ dist/main.js), not "./package.json", so resolve the
	// entry and take its directory — that *is* dist (which also holds the chunks/wasm/fonts).
	return path.dirname(require.resolve("@brianjenkins94/monaco-vscode-api/main"));
}

export function vscodePlugin(): Plugin {
	const libDist = libDistDirectory();
	const gameDist = fileURLToPath(new URL("./dist", import.meta.url));
	// Game entry first (host/workbench), then the lib bundle (main.js + assets).
	const roots = [gameDist, libDist];

	const resolveFile = (relative: string): string | undefined => {
		for (const root of roots) {
			const file = path.join(root, relative);
			if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) {
				return file;
			}
		}
		return undefined;
	};

	return {
		"name": "vscode-workbench",

		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = (req.url ?? "").split("?")[0];
				const index = url.indexOf(MOUNT); // tolerate any base prefix (e.g. /games/war2/)

				if (index === -1) {
					next();
					return;
				}

				const relative = url.slice(index + MOUNT.length);

				// The workbench needs SharedArrayBuffer, so this iframe's document must be
				// cross-origin isolated too — it inherits isolation from the (isolated) host page
				// only if its own responses carry COEP. Match the host's `credentialless` mode.
				res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");

				if (relative === "" || relative === "host.html") {
					res.setHeader("content-type", "text/html");
					res.end(HOST_HTML);
					return;
				}

				const file = resolveFile(relative);

				if (file !== undefined) {
					res.setHeader("content-type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
					res.end(readFileSync(file));
					return;
				}

				next();
			});
		},

		generateBundle() {
			this.emitFile({ "type": "asset", "fileName": "__vscode__/host.html", "source": HOST_HTML });

			const emitted = new Set(["host.html"]);

			const walk = (root: string, directory: string): void => {
				for (const entry of readdirSync(directory, { "withFileTypes": true })) {
					const absolute = path.join(directory, entry.name);

					if (entry.isDirectory()) {
						walk(root, absolute);
					} else {
						const relative = path.relative(root, absolute).split(path.sep).join("/");
						if (emitted.has(relative)) continue; // game entry wins over lib on conflict
						emitted.add(relative);
						this.emitFile({
							"type": "asset",
							"fileName": path.posix.join("__vscode__", relative),
							"source": readFileSync(absolute)
						});
					}
				}
			};

			for (const root of roots) {
				walk(root, root);
			}
		}
	};
}
