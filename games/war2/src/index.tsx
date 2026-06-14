/**
 * war2 host entry — renders the reusable harness shell as JSX, then wires its runtime
 * (boxes + peer pairing) onto the mounted markup. The `<Harness/>` call is why this file
 * is .tsx: war2's esbuild is configured for jsx-async-runtime (see vite.config.ts).
 */
import { jsxToString } from "jsx-async-runtime";
import { Harness, wireHarness, type BoxConfig } from "harness/client";

// One virtual port per box (distinct from the real outer 5173).
const boxes: BoxConfig[] = [
    { port: 5273, role: "host", label: "BOX A · host" },
    { port: 5274, role: "peer", label: "BOX B · peer" },
];

const app = document.getElementById("app")!;
app.innerHTML = await jsxToString.call({}, <Harness title="war2 · two almostnode boxes (one game instance each)" />);
await wireHarness(app, { clientUrl: "client.html", boxes });
