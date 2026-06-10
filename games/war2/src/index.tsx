/**
 * war2 host entry — combines the reusable harness shell + runtime with war2's box config.
 * Renders the static <Harness> shell into #app, then boots the imperative two-box runtime.
 */
import { jsxToString } from "jsx-async-runtime";
import { Harness } from "harness/Harness";
import { bootHarness, type BoxConfig } from "harness/client";

// One virtual port per box (distinct from the real outer 5173).
const boxes: BoxConfig[] = [
    { port: 5273, role: "host", label: "BOX A · host" },
    { port: 5274, role: "peer", label: "BOX B · peer" },
];

const title = "war2 · two almostnode boxes (one game instance each)";

const app = document.getElementById("app")!;
app.innerHTML = await jsxToString.call({}, <Harness title={title} />);
bootHarness(app, { clientUrl: "client.html", boxes });
