/**
 * Static shell for the two-box almostnode harness — deliberately minimal.  It renders
 * only the status log; `wireHarness` routes console + box output into `#status`.  Boxes
 * mount themselves (floating VtWindows, or an on-demand `#frames` row for inline boxes),
 * so the shell provides nothing else.  No events/refs/DOM here — it's stringified by
 * jsx-async-runtime and wired imperatively after mount.
 */
const SHELL_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0a0e17; color: #cdd; font-family: monospace; padding: 12px; min-height: 100vh; }
#status { background: #070b11; border: 1px solid #1a2233; border-radius: 3px; padding: 6px 8px; font-size: 11px; line-height: 1.6; height: 120px; overflow-y: auto; white-space: pre-wrap; }
.ok { color: #5f8; } .err { color: #e55; } .info { color: #7a9; }
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
            <div id="status"></div>
        </>
    );
}
