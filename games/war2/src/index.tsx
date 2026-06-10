/**
 * war2 host entry — combines the reusable harness (built shell + runtime) with war2's box
 * config. No JSX here: bootHarness renders its own shell, so war2 needs no JSX toolchain.
 */
import { bootHarness, type BoxConfig } from "harness/client";

// One virtual port per box (distinct from the real outer 5173).
const boxes: BoxConfig[] = [
    { port: 5273, role: "host", label: "BOX A · host" },
    { port: 5274, role: "peer", label: "BOX B · peer" },
];

const app = document.getElementById("app")!;
await bootHarness(app, {
    title: "war2 · two almostnode boxes (one game instance each)",
    clientUrl: "client.html",
    boxes,
});
