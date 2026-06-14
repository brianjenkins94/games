/**
 * Static shell for the two-box almostnode harness.
 *
 * The consuming game renders this to an HTML string with jsx-async-runtime (no events /
 * refs / DOM). All the live parts — the service worker, the per-box iframes, the peer
 * pairing, and the reload button's onclick — are wired imperatively in `wireHarness`,
 * which looks up `#status`, `#frames`, and `#reload-boxes` by id after this markup is
 * mounted.
 */
const SHELL_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0a0e17; color: #cdd; font-family: monospace; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-height: 100vh; }
h1 { font-size: 13px; letter-spacing: 2px; color: #88aacc; text-transform: uppercase; }
#status { background: #070b11; border: 1px solid #1a2233; border-radius: 3px; padding: 6px 8px; font-size: 11px; line-height: 1.6; height: 120px; overflow-y: auto; white-space: pre-wrap; }
.ok { color: #5f8; } .err { color: #e55; } .info { color: #7a9; }
button { align-self: flex-start; background: #1d3d5c; color: #adf; border: 1px solid #2a5c8a; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-family: monospace; font-size: 12px; }
button:hover { background: #26527c; }
#frames { display: flex; gap: 12px; flex-wrap: wrap; }
.box-wrap { display: flex; flex-direction: column; gap: 4px; }
.box-label { font-size: 11px; color: #668; letter-spacing: 1px; }
iframe { width: 640px; height: 480px; border: 1px solid #334; background: #000; flex-shrink: 0; }
`;

export async function Harness({ title }: { title: string }): Promise<JSX.Element> {
    return (
        <>
            <style>{SHELL_CSS}</style>
            <h1>{title}</h1>
            <div id="status"></div>
            <button id="reload-boxes">⟳ Reload both boxes</button>
            <div id="frames"></div>
        </>
    );
}
