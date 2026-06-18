/**
 * Shared visual theme for the in-browser tooling (the dark host-page palette).
 *
 * Two faces of the same tokens:
 *   • {@link palette} — raw hex strings, for consumers that style plain DOM / third-party
 *     widgets (e.g. the metrics dashboard theming billboard.js's global `.bb-*` classes).
 *   • the Stitches instance (`css`/`theme`/…) — typed CSS-in-JS for component authors
 *     (VtWindow), with `$token` references resolving to the same palette.
 *
 * Uses `@stitches/core` (framework-agnostic — no React) so it fits the source-export →
 * harness-bundle → war2-bundle chain with no build plugin; runtime-injects into
 * document.head on first `css()` use.
 */
import { createStitches } from "@stitches/core";

/** Raw palette — the single source of truth for both faces below. */
export const palette = {
    bg:       "#0a0e17",
    headerBg: "#0d1626",
    border:   "#2a5c8a",
    line:     "#1a2233",
    text:     "#cdd",
    title:    "#88aacc",
    btnBg:    "#16243a",
    btnText:  "#adf",
    btnHover: "#26527c",
    accent:   "#4aa3ff",   // primary series / links (bright on dark)
    accent2:  "#e0843a",   // secondary series / guide-lines (warm contrast)
} as const;

export const { css, theme, keyframes, globalCss } = createStitches({
    theme: {
        colors: { ...palette },
    },
});

// ── Icons (lucide) ───────────────────────────────────────────────────────────────
//
// Framework-agnostic: lucide ships each icon as plain data (an array of [tag, attrs]
// SVG children), which we render to an SVG node here.  So `theme` takes NO dependency on
// lucide or any UI framework — the consumer imports the specific icons it needs from
// `lucide` (tree-shaken) and passes them in:
//
//   import { X } from "lucide";
//   import { icon, iconSvg } from "theme";
//   el.append(icon(X, { size: 14 }));                                   // vanilla DOM
//   <span dangerouslySetInnerHTML={{ __html: iconSvg(X, { size: 14 }) }} />   // Preact
//
// Icons are stroke-based with stroke:"currentColor", so they inherit the surrounding
// text colour (the palette) for free — set `color` on a parent and the icon follows.

/** lucide's per-icon shape: a flat list of SVG children as [tag, attributes] pairs.
 *  Declared locally (not imported) so `theme` stays dependency-free; lucide's own
 *  `IconNode` is structurally assignable to this. */
export type IconNode = readonly [tag: string, attrs: Record<string, string | number>][];

export interface IconOptions {
    /** Width & height in px (lucide's 24px artboard is scaled to this). Default 16. */
    size?: number;
    /** Stroke width. Default 2 (lucide's default). */
    stroke?: number;
    /** Extra class(es) added alongside `lucide`. */
    class?: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Render a lucide icon node to an `<svg>` DOM element. */
export function icon(node: IconNode, { size = 16, stroke = 2, class: cls }: IconOptions = {}): SVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    const attrs: Record<string, string | number> = {
        viewBox: "0 0 24 24", width: size, height: size,
        fill: "none", stroke: "currentColor", "stroke-width": stroke,
        "stroke-linecap": "round", "stroke-linejoin": "round",
        class: cls ? `lucide ${cls}` : "lucide",
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    for (const [tag, childAttrs] of node) {
        const child = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(childAttrs)) child.setAttribute(k, String(v));
        svg.appendChild(child);
    }
    return svg;
}

/** Render a lucide icon node to an SVG markup string (for innerHTML / dangerouslySetInnerHTML). */
export function iconSvg(node: IconNode, options?: IconOptions): string {
    return icon(node, options).outerHTML;
}
