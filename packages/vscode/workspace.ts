/**
 * Default workbench settings — owned by games. Files now come from the host (war2 passes its
 * real `src` over postMessage), so only the editor settings/keybindings live here.
 */

/** VS Code user settings (settings.json), passed to `boot({ configuration })`. */
export const configuration: Record<string, unknown> = {
	"workbench.colorTheme": "Default Dark+",
	"workbench.iconTheme": "vs-seti",
	"editor.fontSize": 12,
	"editor.semanticHighlighting.enabled": true,
	"editor.bracketPairColorization.enabled": false,
	"editor.scrollBeyondLastLine": true,
	"editor.mouseWheelZoom": true,
	"files.autoSave": "off",
	"workbench.sideBar.location": "left",
	// node_modules is seeded/CDN-resolved for the TS server only — keep it out of the explorer.
	// (Doesn't affect module resolution; it's an explorer/search filter.)
	"files.exclude": { "**/node_modules": true }
};

/** Keybindings (keybindings.json), passed to `boot({ keybindings })`. */
export const keybindings: unknown[] = [
	{ key: "ctrl+d", command: "editor.action.deleteLines", when: "editorTextFocus" }
];
