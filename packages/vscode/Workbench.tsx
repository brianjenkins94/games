/** @jsxImportSource preact */
/**
 * Game-composed VS Code workbench shell.
 *
 * Each region (sidebar / editors / panel / auxbar / status bar) is its own small, independently
 * configurable sub-component: it accepts an extra `class` and `children`, so markup or CSS can be
 * layered in from games as needed without touching lib. `<Workbench/>` arranges them in a stitches
 * grid and hands the resolved container elements to lib's `boot()` (via `onReady`), which attaches
 * the real workbench parts into them.
 *
 * Styling is stitches (`theme`), so it shares the palette and injects into this document's head —
 * which works because this whole tree is rendered *inside the iframe* by `workbench-entry.tsx`.
 */
import { css, globalCss, iconSvg } from "theme";
import { useState } from "preact/hooks";
import { Bug, Files, Search } from "lucide";
import type { ComponentChildren, Ref } from "preact";
import type { WorkbenchParts } from "@brianjenkins94/monaco-vscode-api/main";

const shell = css({
	display: "grid",
	height: "100%",
	// 5px "handle" tracks sit between sidebar/editors/auxbar and above the console (panel) — a solid
	// divider at rest, blue on hover; the pure-CSS resize controls below drive them. The handle must be
	// OPAQUE: it masks the region's native resize grip (a `::-webkit-resizer` stretched 100× by the
	// region's `scale`, which is otherwise visible). The grab zone is this exposed track (the region
	// sits under the panels, so only the gap is hittable) — hence 5px, not 1px. Console spans full width.
	// The resizable tracks (sidebar/auxbar columns, console row) are `max-content`, so a control's
	// hidden `.region` drives them: the region fills its area (`min-width/height:100%`, so its native
	// resize grip sits ON the handle strip — not buried under the part) and dragging it past the
	// part's size grows the `max-content` track. Editors column + main row are `1fr` and absorb the
	// slack. Resize is GROW-only: dragging inward clamps at 100% and the part floors the track.
	gridTemplate: `
		"header  header         header         header         header"         min-content
		"sidebar sidebar-handle editors        auxbar-handle  auxbar"         1fr
		"sidebar sidebar-handle console-handle console-handle console-handle" 5px
		"sidebar sidebar-handle console        console        console"        max-content
		"footer  footer         footer         footer         footer"         min-content
		/ max-content 5px       1fr            5px            max-content`
});

const region = (area: string, extra: Record<string, unknown> = {}) =>
	css({ gridArea: area, zIndex: 1, ...extra });

const headerCss = region("header");
// Sidebar area = our own 48px activity bar (icon switcher) laid beside the real sidebar part.
const sidebarCss = region("sidebar", { display: "flex", backgroundColor: "var(--vscode-sideBar-background)" });
// The activity bar: a darker (editor-bg) strip of icon buttons that switch the sidebar viewlet.
const activityBarCss = css({ flex: "0 0 48px", display: "flex", flexDirection: "column", backgroundColor: "var(--vscode-editor-background)", zIndex: 1 });
const activityItemCss = css({
	height: 48,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	padding: 0,
	background: "transparent",
	border: "none",
	borderLeft: "2px solid transparent",   // active indicator slot (keeps icons from shifting)
	color: "var(--vscode-icon-foreground)",   // solid gray (opaque — not the translucent inactiveForeground that looked blurry)
	cursor: "pointer",
	transition: "color 0.1s ease",
	"&:hover": { color: "var(--vscode-activityBar-foreground)" },   // brighten on hover
	"&.active": { color: "var(--vscode-activityBar-foreground)", borderLeftColor: "var(--vscode-activityBar-activeBorder)" },   // active brightens to white + left bar
	"& svg": { display: "block", width: 24, height: 24 },   // iconSvg uses currentColor → driven by `color`
});
// The real sidebar part attaches into this; it fills the space beside the activity bar.
const sidebarPartCss = css({ flex: "1 1 auto", minWidth: 0, position: "relative" });
const editorsCss = region("editors");
const consoleCss = region("console");
const auxbarCss = region("auxbar", { display: "block !important" });
const footerCss = region("footer");

// Monaco injects its parts *inside* the containers below; make them fill their region.
const injectGlobals = globalCss({
	// VS Code scopes the UI font to `.monaco-workbench-part` descendants only, so body-level
	// overlays (context menus, the command palette) — which render in a bare `.context-view`
	// appended to the body — miss it and fall back to the browser's serif default. Set the
	// platform font on the workbench root (the body) so it cascades to those too. The editor
	// sets its own monospace font explicitly, so this doesn't affect it.
	".monaco-workbench.mac": { fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif" },
	".monaco-workbench.windows": { fontFamily: '"Segoe WPC", "Segoe UI", sans-serif' },
	".monaco-workbench.linux": { fontFamily: 'system-ui, "Ubuntu", "Droid Sans", sans-serif' },
	'[id^="workbench.parts."]': { height: "100%" },
	'[id^="workbench.parts."] > .content': { height: "100% !important", width: "100% !important" }
});

// Pure-CSS resize controls (faithful port of the original layout — no JS). Each divider is a thin
// grid "handle" track; a hidden native-`resize` `.region` is transformed to overlap that strip, so
// dragging it resizes the adjacent part. `display:contents` lets each control's region + handle act
// as direct grid items. The handle is the visible line (pointer-events:none → the drag reaches the
// region beneath). The region's `scale`/`translate` map the tiny native resize grip onto the whole
// handle strip and flip it so it grips from the correct edge. Scoped under `.wb-shell`.
const injectControls = globalCss({
	".wb-shell .sidebar-control": { display: "contents" },
	".wb-shell .console-control": { display: "contents" },
	".wb-shell .auxbar-control": { display: "contents" },

	".wb-shell .sidebar-control > .handle": { gridArea: "sidebar-handle", backgroundColor: "var(--vscode-editorGroup-border)", zIndex: 10, pointerEvents: "none", transition: "background-color 0.15s ease" },
	".wb-shell .sidebar-control:hover > .handle": { backgroundColor: "var(--vscode-sash-hoverBorder)" },
	".wb-shell .sidebar-control > .region": { gridArea: "sidebar / sidebar / sidebar-handle / sidebar-handle", minWidth: "100%", overflow: "hidden", resize: "horizontal", transformOrigin: "bottom right", scale: "1 100" },

	".wb-shell .console-control > .handle": { gridArea: "console-handle", backgroundColor: "var(--vscode-editorGroup-border)", zIndex: 10, pointerEvents: "none", transition: "background-color 0.15s ease" },
	".wb-shell .console-control:hover > .handle": { backgroundColor: "var(--vscode-sash-hoverBorder)" },
	".wb-shell .console-control > .region": { gridArea: "console-handle / console-handle / console / console", minHeight: "100%", maxHeight: "80vh", overflow: "hidden", resize: "vertical", transformOrigin: "bottom right", scale: "-100 -1", translate: "-100% -100%" },

	".wb-shell .auxbar-control > .handle": { gridArea: "auxbar-handle", backgroundColor: "var(--vscode-editorGroup-border)", zIndex: 10, pointerEvents: "none", transition: "background-color 0.15s ease" },
	".wb-shell .auxbar-control:hover > .handle": { backgroundColor: "var(--vscode-sash-hoverBorder)" },
	".wb-shell .auxbar-control > .region": { gridArea: "auxbar-handle / auxbar-handle / auxbar / auxbar", minWidth: "100%", overflow: "hidden", resize: "horizontal", transformOrigin: "bottom left", scale: "-1 100", translate: "100% 0" }
});

const cx = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base);

interface RegionProps {
	/** Ref to the container the corresponding workbench part attaches into. */
	containerRef?: Ref<HTMLElement>;
	/** Extra class(es) to layer on. */
	class?: string;
	children?: ComponentChildren;
}

export function Header({ class: c, children }: Omit<RegionProps, "containerRef">) {
	return <header class={cx(headerCss(), c)}>{children}</header>;
}

/** The icon buttons that switch the sidebar viewlet (Explorer / Search / Run & Debug). Clicking runs
 *  the matching VS Code `workbench.view.*` command via the per-extension API the consumer passes in. */
const ACTIVITY_ITEMS = [
	{ id: "explorer", title: "Explorer", icon: Files, command: "workbench.view.explorer" },
	{ id: "search", title: "Search", icon: Search, command: "workbench.view.search" },
	{ id: "debug", title: "Run and Debug", icon: Bug, command: "workbench.view.debug" },
] as const;

function ActivityBar({ runCommand }: { runCommand: (command: string) => void }) {
	const [active, setActive] = useState<string>(ACTIVITY_ITEMS[0].id);
	return (
		<div class={activityBarCss()}>
			{ACTIVITY_ITEMS.map((item) => (
				<button
					key={item.id}
					type="button"
					class={cx(activityItemCss(), active === item.id ? "active" : "")}
					title={item.title}
					aria-label={item.title}
					onClick={() => { setActive(item.id); runCommand(item.command); }}
					dangerouslySetInnerHTML={{ __html: iconSvg(item.icon, { size: 24 }) }}
				/>
			))}
		</div>
	);
}

export function Sidebar({ containerRef, class: c, children, runCommand }: RegionProps & { runCommand: (command: string) => void }) {
	return (
		<nav class={cx(sidebarCss(), c)}>
			<ActivityBar runCommand={runCommand} />
			<div class={sidebarPartCss()} ref={containerRef as Ref<HTMLElement>}>{children}</div>
		</nav>
	);
}

export function Editors({ containerRef, class: c, children }: RegionProps) {
	return <section class={cx(editorsCss(), c)} ref={containerRef as Ref<HTMLElement>}>{children}</section>;
}

export function Console({ containerRef, class: c, children }: RegionProps) {
	return <section class={cx(consoleCss(), c)} ref={containerRef as Ref<HTMLElement>}>{children}</section>;
}

export function Auxbar({ containerRef, class: c, children }: RegionProps) {
	return <aside class={cx(auxbarCss(), c)} ref={containerRef as Ref<HTMLElement>}>{children}</aside>;
}

export function StatusBar({ containerRef, class: c, children }: RegionProps) {
	return (
		<footer class={cx(footerCss(), c)}>
			<div ref={containerRef as Ref<HTMLElement>}>{children}</div>
		</footer>
	);
}

/**
 * Compose the default layout and report the five part containers once all are mounted.
 * Swap/extend the regions here (or pass `class`/`children` into them) to customise the shell.
 */
export function Workbench({ onReady, runCommand }: { onReady: (parts: WorkbenchParts) => void; runCommand: (command: string) => void }) {
	injectGlobals();
	injectControls();

	const parts: Partial<WorkbenchParts> = {};
	const collect = (key: keyof WorkbenchParts) => (element: HTMLElement | null) => {
		if (element == null) return;
		parts[key] = element;
		if (parts.sidebar && parts.editors && parts.panel && parts.statusbar && parts.auxbar) {
			onReady(parts as WorkbenchParts);
		}
	};

	// Each part is followed by its resize control (region + handle); the handle is the draggable
	// divider, the region the hidden native-resize element beneath it. DOM order matches the grid.
	return (
		<main class={`wb-shell ${shell()}`}>
			<Header />
			<Sidebar containerRef={collect("sidebar")} runCommand={runCommand} />
			<div class="sidebar-control"><div class="region" /><div class="handle" /></div>
			<Editors containerRef={collect("editors")} />
			<Console containerRef={collect("panel")} />
			<div class="console-control"><div class="region" /><div class="handle" /></div>
			<Auxbar containerRef={collect("auxbar")} />
			<div class="auxbar-control"><div class="region" /><div class="handle" /></div>
			<StatusBar containerRef={collect("statusbar")} />
		</main>
	);
}
