/** @jsxImportSource preact */
/**
 * Iframe entry — runs *inside* the workbench iframe (served at /__vscode__/host.html).
 *
 * Renders the game-composed <Workbench/> shell, then boots lib's monaco workbench into the
 * resolved part containers once the host page has sent the workspace (files/openEditors) over
 * postMessage. On save, it posts the edited path + contents back to the host (war2 writes those
 * into the box's VirtualFS for a live preview). `boot`/`registerExtension` come from the pre-built
 * lib bundle, kept external and mapped to the sibling `./main.js`.
 */
import { render } from "preact";
import { boot, registerExtension, ExtensionHostKind, registerFileSystemOverlay, type WorkbenchFile, type WorkbenchParts } from "@brianjenkins94/monaco-vscode-api/main";
import { Workbench } from "./Workbench";
import { createNodeModulesProvider } from "./node-modules-provider";
import { createAssetsProvider } from "./assets-provider";
import { configuration, keybindings } from "./workspace";

interface Init { files: WorkbenchFile[]; openEditors: string[]; workspaceFolder?: string; moduleVersions?: Record<string, string>; assetsBase?: string; }

let parts: WorkbenchParts | undefined;
let init: Init | undefined;
let booted = false;

function maybeBoot(): void {
	if (booted || parts === undefined || init === undefined) return;
	booted = true;
	const { files, openEditors, workspaceFolder, moduleVersions, assetsBase } = init;

	boot({
		parts,
		files,
		openEditors,
		workspaceFolder,
		configuration,
		keybindings,
		onSave: (path, contents) => {
			window.parent.postMessage({ source: "vscode", type: "save", path, contents }, "*");
		}
	})
		.then(() => {
			// Games customization: CDN-backed node_modules overlay (unpkg) for go-to-definition into
			// deps. Registered after init so the file service is up; lower priority than the seeded
			// source/snapshot overlay, so it only handles uncovered node_modules paths.
			if (moduleVersions != null) {
				registerFileSystemOverlay(0, createNodeModulesProvider(workspaceFolder ?? "/workspace", moduleVersions));
			}
			// Games customization: read-only overlay for the game's static assets (from tree.txt).
			if (assetsBase != null) {
				registerFileSystemOverlay(0, createAssetsProvider(workspaceFolder ?? "/workspace", assetsBase));
			}
			// Default extension so the vscode API has a context (lib no longer does this).
			registerExtension(
				{ name: "war2", publisher: "brianjenkins94", version: "1.0.0", engines: { vscode: "*" } },
				ExtensionHostKind.LocalProcess
			).setAsDefaultApi();
		})
		.catch((error) => {
			console.error("[vscode] workbench boot failed", error);
		});
}

window.addEventListener("message", (event) => {
	if (event.source !== window.parent) return;
	const data = event.data as { source?: string; type?: string } & Partial<Init> | null;
	if (data?.source === "vscode-host" && data.type === "init") {
		init = { files: data.files ?? [], openEditors: data.openEditors ?? [], workspaceFolder: data.workspaceFolder, moduleVersions: data.moduleVersions, assetsBase: data.assetsBase };
		maybeBoot();
	}
});

render(<Workbench onReady={(resolved) => { parts = resolved; maybeBoot(); }} />, document.body);

// Tell the host we're ready to receive the workspace.
window.parent.postMessage({ source: "vscode", type: "ready" }, "*");
