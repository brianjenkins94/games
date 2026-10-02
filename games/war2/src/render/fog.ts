/**
 * Fog of war, as drawn: each tile unexplored, explored, or visible now — for the viewing team only. What the team has
 * explored comes from its client worker (the referee's own record, sent with the view); what it sees now is within
 * sight of its own units, by the same dodecagonal metric the sim uses (sim/vision.ts), so the drawn fog matches the
 * game's. Pushed to the ChunkRenderer, which dims or blacks terrain accordingly. (The old renderer kept its own
 * explored record and recomputed visibility for the whole map three times a frame; W3, see MIGRATION.md.)
 */
import type { UnitInfo } from "../browser/bootstrap.ts";
import { FP, TILE_PX } from "../sim/components.ts";
import { inRange } from "../sim/distance.ts";
import { unitSight, unitTypeId } from "../sim/unitTypes.ts";

export const UNEXPLORED = 0;
export const EXPLORED = 1;
export const VISIBLE = 2;

/** Fill `vis` (mapW×mapH): explored from the runs ([start, length, …]), visible around each of `own`. */
export function computeFog(vis: Uint8Array, mapW: number, mapH: number, exploredRuns: number[], own: UnitInfo[]): void {
	vis.fill(UNEXPLORED);

	for (let index = 0; index < exploredRuns.length; index += 2) {
		vis.fill(EXPLORED, exploredRuns[index], exploredRuns[index] + exploredRuns[index + 1]);
	}

	for (const unit of own) {
		const sight = unitSight(unitTypeId(unit.type));
		const utx = Math.floor(unit.x / FP / TILE_PX);
		const uty = Math.floor(unit.y / FP / TILE_PX);

		for (let ty = Math.max(0, uty - sight); ty <= Math.min(mapH - 1, uty + sight); ty++) {
			for (let tx = Math.max(0, utx - sight); tx <= Math.min(mapW - 1, utx + sight); tx++) {
				if (inRange(tx - utx, ty - uty, sight)) {
					vis[ty * mapW + tx] = VISIBLE;
				}
			}
		}
	}
}
