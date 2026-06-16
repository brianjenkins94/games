/**
 * war2 host entry — renders the reusable harness shell as JSX, then wires its runtime
 * (boxes + peer pairing) onto the mounted markup. The `<Harness/>` call is why this file
 * is .tsx: war2's esbuild is configured for jsx-async-runtime (see vite.config.ts).
 */
import { jsxToString } from "jsx-async-runtime";
import { Harness, wireHarness, type BoxConfig } from "harness/client";

// One virtual port per box (distinct from the real outer 5173).
const boxes: BoxConfig[] = [
    // Both boxes run in floating windows.  The host stays open; the peer starts
    // minimized once both have initialized — available for debugging, out of the way.
    { port: 5273, role: "host", label: "BOX A · host", windowed: true },
    { port: 5274, role: "peer", label: "BOX B · peer", windowed: true, startMinimized: true },
];

const app = document.getElementById("app")!;
app.innerHTML = await jsxToString.call({}, <Harness />);
await wireHarness(app, { clientUrl: "client.html", boxes });
