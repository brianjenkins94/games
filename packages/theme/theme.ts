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
