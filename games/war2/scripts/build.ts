/** `npm run build`: util's app build — every .html entry, deployed under /games/war2/, to the repo's docs/war2/. */
import * as path from "node:path";
import { buildApp } from "@brianjenkins94/util/vite/build";

await buildApp(process.cwd(), path.resolve(process.cwd(), "../.."), { "baseDir": "games" });
