/**
 * netsim's browser harness: game-test's (packages/game-test/harness.ts), bound to netsim.
 */
import type { Game } from "../../../../packages/game-test/harness.ts";
import * as path from "node:path";
import { createHarness } from "../../../../packages/game-test/harness.ts";

export type { ServeOptions, Session, Status } from "../../../../packages/game-test/harness.ts";
export { until } from "../../../../packages/game-test/harness.ts";

export const game: Game = { "name": "netsim", "root": path.resolve(import.meta.dirname, "../.."), "global": "__netsim", "clients": 3 };
export const { serveBuild, startSession, status, untilInSync, tool } = createHarness(game);
