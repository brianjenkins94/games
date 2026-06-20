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
import { SimDebugAdapter, type SimEvent } from "./sim-debug-adapter";

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
			// Default extension so the vscode API has a context (lib no longer does this). Also
			// contributes the "war2-sim" debugger so the step-debugger adapter can attach.
			const ext = registerExtension(
				{
					name: "war2", publisher: "brianjenkins94", version: "1.0.0", engines: { vscode: "*" },
					// A `browser` entry point is mandatory for the extension to be flagged web-enabled;
					// without it the extension is disabled and getApi() rejects. The file is a no-op.
					browser: "extension.js",
					contributes: { debuggers: [{ type: "war2-sim", label: "war2 sim", languages: [] }] },
				},
				ExtensionHostKind.LocalProcess
			);
			ext.registerFileUrl("./extension.js", "data:text/javascript;base64," + window.btoa("// nothing"));
			ext.setAsDefaultApi();
			ext.getApi().then(setupSimDebugger).catch((e) => console.error("[vscode] sim debugger setup failed", e));

			// Tell the host the workbench is up (readiness gating — see war2 index.tsx "workbench" stage).
			window.parent.postMessage({ source: "vscode", type: "online" }, "*");
		})
		.catch((error) => {
			console.error("[vscode] workbench boot failed", error);
		});
}

/**
 * Wire the step-debugger: an inline DAP adapter whose toolbar drives the game sim. Control flows
 * adapter → window.parent (→ host → game box); sim events flow back via "vscode-host" messages.
 * `vscode` is the per-extension API from registerExtension().getApi(). The session is opt-in
 * (start "war2 sim" from Run & Debug) — auto-attaching leaked the renderer against the live sim.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setupSimDebugger(vscode: any): void {
	const emitter = new vscode.EventEmitter();
	const adapter = new SimDebugAdapter(
		(message) => emitter.fire(message),
		(msg) => window.parent.postMessage({ source: "vscode", type: "debug-control", msg }, "*"),
	);
	const dap = { onDidSendMessage: emitter.event, handleMessage: (m: unknown) => adapter.handleMessage(m), dispose() {} };

	vscode.debug.registerDebugConfigurationProvider("war2-sim", {
		resolveDebugConfiguration: () => ({ name: "war2 sim", type: "war2-sim", request: "attach" }),
	});
	vscode.debug.registerDebugAdapterDescriptorFactory("war2-sim", {
		createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(dap),
	});

	window.addEventListener("message", (event: MessageEvent) => {
		const d = event.data as { source?: string; type?: string; msg?: SimEvent } | null;
		if (d?.source === "vscode-host" && d.type === "debug-event" && d.msg) adapter.onSimEvent(d.msg);
	});

	// NOTE: do NOT auto-attach. An always-on session against the live sim leaked the renderer
	// (~45MB/s → OOM "Aw Snap"); the debugger is opt-in — start it from Run & Debug ("war2 sim").
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
