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
import { css, globalCss } from "theme";
import type { ComponentChildren, Ref } from "preact";
import type { WorkbenchParts } from "@brianjenkins94/monaco-vscode-api/main";

const shell = css({
	display: "grid",
	height: "100%",
	gridTemplate: `
		"header  header  header"  min-content
		"sidebar editors auxbar"  2fr
		"sidebar console console" 1fr
		"footer  footer  footer"  min-content
		/ 300px  3fr     1fr`
});

const region = (area: string, extra: Record<string, unknown> = {}) =>
	css({ gridArea: area, zIndex: 1, ...extra });

const headerCss = region("header");
const sidebarCss = region("sidebar", { paddingLeft: 48, backgroundColor: "#2c2c2c" });
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

export function Sidebar({ containerRef, class: c, children }: RegionProps) {
	return <nav class={cx(sidebarCss(), c)} ref={containerRef as Ref<HTMLElement>}>{children}</nav>;
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
export function Workbench({ onReady }: { onReady: (parts: WorkbenchParts) => void }) {
	injectGlobals();

	const parts: Partial<WorkbenchParts> = {};
	const collect = (key: keyof WorkbenchParts) => (element: HTMLElement | null) => {
		if (element == null) return;
		parts[key] = element;
		if (parts.sidebar && parts.editors && parts.panel && parts.statusbar && parts.auxbar) {
			onReady(parts as WorkbenchParts);
		}
	};

	return (
		<main class={shell()}>
			<Header />
			<Sidebar containerRef={collect("sidebar")} />
			<Editors containerRef={collect("editors")} />
			<Console containerRef={collect("panel")} />
			<Auxbar containerRef={collect("auxbar")} />
			<StatusBar containerRef={collect("statusbar")} />
		</main>
	);
}
