/**
 * Static shell for the two-box almostnode harness — deliberately minimal.  Boxes mount
 * themselves (floating VtWindows, or an on-demand `#frames` row for inline boxes), so the
 * shell carries only the page chrome; boot/box logging goes to the browser console.  No
 * events/refs/DOM here — it's stringified by jsx-async-runtime and wired imperatively.
 */
const SHELL_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0a0e17; color: #cdd; font-family: monospace; padding: 12px; min-height: 100vh; }
/* Inline-box mode (when a box isn't windowed): wireHarness creates #frames on demand. */
#frames { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
.box-wrap { display: flex; flex-direction: column; gap: 4px; }
.box-label { font-size: 11px; color: #668; letter-spacing: 1px; }
#frames iframe { width: 640px; height: 480px; border: 1px solid #334; background: #000; flex-shrink: 0; }
`;

export async function Harness(): Promise<JSX.Element> {
    return (
        <>
            <style>{SHELL_CSS}</style>
        </>
    );
}
