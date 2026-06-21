/** @jsxImportSource preact */
/**
 * VS Code workbench in a floating VtWindow.
 *
 * The workbench runs inside an <iframe> (its own document) so it survives VtWindow's detach
 * (which re-parents/reloads the body) and so monaco taking over `document.body` never touches the
 * host page. The iframe loads `/__vscode__/host.html`, which runs the game entry (workbench.js).
 *
 * Files + saves cross the iframe boundary over postMessage (same origin): the entry signals
 * "ready" → we send it the workspace `files`/`openEditors`; it posts "save" back with the edited
 * path + contents, which we hand to `onSave` (war2 writes that into the box's VirtualFS for a live
 * preview). The host app must only call this once `crossOriginIsolated` is true (SharedArrayBuffer).
 *
 * Singleton — monaco-vscode-api is one global workbench; subsequent calls are no-ops.
 */
import { render } from "preact";
import { css } from "theme";
import { VtWindow } from "window";
import type { WorkbenchFile } from "@brianjenkins94/monaco-vscode-api/main";

const iframeStyle = css({ border: 0, width: "100%", height: "100%" });

export interface VscodeWindowOptions {
	/** Files to seed the workbench with. */
	files?: WorkbenchFile[];
	/** Files (by path) opened on first layout. */
	openEditors?: string[];
	/** Workspace folder the files live under (shown as the explorer root, e.g. "/war2"). */
	workspaceFolder?: string;
	/** Package version map (name → version/range). When set, node_modules resolves from the unpkg
	 *  CDN (pinned where known) so imports work in a static deploy. Workspace-only packages should
	 *  be passed via `files` instead (they aren't on the CDN). */
	moduleVersions?: Record<string, string>;
	/** Same-origin base for the game's static assets (with a `tree.txt` index). When set, mounts a
	 *  read-only `<workspaceFolder>/assets` overlay. e.g. "/assets/war2/" (prod) or "/src/assets/" (dev). */
	assetsBase?: string;
	/** Called in *this* document when a document is saved in the workbench. */
	onSave?: (path: string, contents: string) => void;
	/** Called with step-debugger control messages the workbench's DAP adapter emits (pause/step/…).
	 *  The host wires these to a game box; events flow back via the returned `sendDebugEvent`. */
	onDebugControl?: (msg: unknown) => void;
	/** Where to mount the floating window. Default: document.body. */
	mountInto?: HTMLElement;
}

/** Handle returned by createVscodeWindow for talking to the workbench after it's mounted. */
export interface VscodeWindowHandle {
	/** Push a step-debugger event (sim `stopped` / `debug-state`) into the workbench's adapter. */
	sendDebugEvent(msg: unknown): void;
	/** Resolves once the workbench has actually booted (monaco mounted), for readiness gating. */
	whenReady: Promise<void>;
}

let booted = false;

export function createVscodeWindow(options: VscodeWindowOptions = {}): VscodeWindowHandle {
	if (booted) return { sendDebugEvent() {}, whenReady: Promise.resolve() };
	booted = true;

	let markReady: () => void;
	const whenReady = new Promise<void>((resolve) => { markReady = resolve; });

	const { files = [], openEditors = [], workspaceFolder, moduleVersions, assetsBase, onSave, onDebugControl, mountInto = document.body } = options;
	const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";

	const iframe = document.createElement("iframe");
	// Explicit host page (not the directory root): monaco's own dist/index.html is the webview
	// pre-page, so the workbench host ships as host.html alongside it.
	iframe.src = base + "__vscode__/host.html";
	iframe.className = iframeStyle();

	// The workbench's window — the in-page iframe, or (once popped out) the standalone tab. We don't
	// hardcode `iframe.contentWindow`: instead we track whoever is currently handshaking via
	// `event.source`, so the same bridge serves both topologies. The popped-out page reaches us via
	// `window.opener` (see workbench-entry's `host = opener ?? parent`).
	let contentWindow: Window | null = null;

	// The workbench window. A draw() closure (not a one-shot render) so we can collapse it to the
	// minimized strip once monaco has booted — minimizing before mount would lay the editor out at 0×0.
	const container = document.createElement("div");
	mountInto.appendChild(container);
	let minimized = false;
	const draw = (): void => {
		render(
			<VtWindow
				title="VS Code" body={iframe}
				top={80} left={80} width={1100} height={720}
				detachable closable={false}
				minimized={minimized}
				onMinimizedChange={(m) => { minimized = m; draw(); }}
			/>,
			container,
		);
	};
	draw();

	// Bridge to the workbench entry. Kept registered (not one-shot) so a detach/reload re-handshakes.
	window.addEventListener("message", (event) => {
		const data = event.data as { source?: string; type?: string; path?: string; contents?: string; msg?: unknown } | null;
		if (data?.source !== "vscode") return;
		contentWindow = event.source as Window;   // reply target: in-page iframe or popped-out tab

		if (data.type === "ready") {
			contentWindow.postMessage({ source: "vscode-host", type: "init", files, openEditors, workspaceFolder, moduleVersions, assetsBase }, "*");
		} else if (data.type === "save" && typeof data.path === "string" && typeof data.contents === "string") {
			onSave?.(data.path, data.contents);
		} else if (data.type === "debug-control") {
			onDebugControl?.(data.msg);
		} else if (data.type === "online") {
			markReady();
			minimized = true;   // collapse to the strip now that monaco is up (mounted at full size first)
			draw();
		}
	});

	return {
		sendDebugEvent(msg: unknown): void {
			contentWindow?.postMessage({ source: "vscode-host", type: "debug-event", msg }, "*");
		},
		whenReady,
	};
}
