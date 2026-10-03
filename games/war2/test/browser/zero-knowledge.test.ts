/**
 * The zero-knowledge line: probes alone — injected from outside, with war2's own observability stubbed out — draw what
 * war2's self-reported architecture draws (packages/game-test/zero-knowledge/compare.ts: `holdsTheLine`).
 */
import { test } from "node:test";
import { compareZeroKnowledge, holdsTheLine } from "../../../../packages/game-test/zero-knowledge/compare.ts";
import * as harness from "./harness.ts";

test("probes alone draw the host page: its frames, their workers, the referee — and every link between them", async () => {
	holdsTheLine(await compareZeroKnowledge(harness.game, harness, "host"));
});

test("probes alone draw a match across tabs: each tab's page, frame and worker, the lobby and its locks, and the referee", async () => {
	holdsTheLine(await compareZeroKnowledge(harness.game, harness, "tabs"));
});
