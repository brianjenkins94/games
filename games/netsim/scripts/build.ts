/** `npm run build`: util's app build — every .html entry, deployed under /games/netsim/, to the repo's docs/netsim/. */
import * as path from "node:path";
import { buildApp } from "@brianjenkins94/util/vite/build";

await buildApp(process.cwd(), path.resolve(process.cwd(), "../.."), { "baseDir": "games" });
