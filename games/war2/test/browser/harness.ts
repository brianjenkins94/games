/**
 * war2's browser harness: game-test's (packages/game-test/harness.ts), bound to war2 — plus war2's own pathology guard (`assertQuiet`). Scenarios open the small `arena` map.
 */
import type { Page } from "playwright";
import type { Game } from "../../../../packages/game-test/harness.ts";
import * as path from "node:path";
import { createHarness } from "../../../../packages/game-test/harness.ts";

export type { ServeOptions, Session, Status } from "../../../../packages/game-test/harness.ts";
export { until } from "../../../../packages/game-test/harness.ts";

export const game: Game = { "name": "war2", "root": path.resolve(import.meta.dirname, "../.."), "global": "__war2", "clients": 2, "query": "map=arena" };
export const { serveBuild, startSession, status, untilInSync, tool } = createHarness(game);

/** The pathology guard: the referee's detector flagged nothing in this match (an incident flagged by hand doesn't
 *  count). For tests that give deliberate orders — bots wander into the pathing's known faults. */
export async function assertQuiet(page: Page): Promise<void> {
	const incidents = (await tool<{ "id": string; "label": string }[]>(page, "war2_incidents")).filter((incident) => incident.label.startsWith("auto:"));

	if (incidents.length > 0) {
		throw new Error(`pathing incident(s) flagged: ${incidents.map((incident) => `${incident.id} ${incident.label}`).join("; ")} — war2_replay_incident <id> to look, war2_save_incident_test to pin it`);
	}
}
