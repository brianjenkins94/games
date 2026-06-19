/**
 * Static shell for the two-box almostnode harness — deliberately minimal.  Boxes mount
 * themselves (floating VtWindows, or an on-demand `#frames` row for inline boxes), so the
 * shell only injects the page chrome; boot/box logging goes to the browser console.
 *
 * Page-level styling goes through theme's `globalCss` (Stitches) rather than a raw <style>
 * string, so it shares the palette tokens ($bg/$text) with the rest of the tooling instead
 * of duplicating hex values.  No events/refs/DOM here — it's stringified by jsx-async-runtime
 * and wired imperatively; the `globalCss()` call injects into document.head as a side effect.
 */
import { globalCss } from "theme";

const injectShell = globalCss({
    "*": { margin: 0, padding: 0, boxSizing: "border-box" },
    body: { background: "$bg", color: "$text", fontFamily: "monospace", padding: 12, minHeight: "100vh" },
    // Inline-box mode (when a box isn't windowed): wireHarness creates #frames on demand.
    "#frames": { display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 },
    ".box-wrap": { display: "flex", flexDirection: "column", gap: 4 },
    ".box-label": { fontSize: 11, color: "#668", letterSpacing: 1 },
    "#frames iframe": { width: 640, height: 480, border: "1px solid #334", background: "#000", flexShrink: 0 },
});

export async function Harness(): Promise<JSX.Element> {
    injectShell();
    return <></>;
}
