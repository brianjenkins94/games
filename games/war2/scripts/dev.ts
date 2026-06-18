/**
 * war2 dev — deviates from the plain per-package dev server (`serve`) to also run
 * war2's PeerJS broker (:9000) and debug WebSocket server (:9229) in the same process
 * tree, replacing the old `concurrently` trio. Children run in this directory so
 * their deps (peer, ws) resolve here.
 */
import { spawn } from "node:child_process";
import { serve } from "@brianjenkins94/util/vite/dev";

const children = [
    spawn("npx", ["peer", "--port", "9000"], { stdio: "inherit" }),
    spawn("node", ["tools/debug-server.mjs"], { stdio: "inherit" }),
];
const shutdown = () => { for (const c of children) c.kill(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await serve(process.cwd());
