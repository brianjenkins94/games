/**
 * How a match opens, as a WC2 match does: each team at its start (the map's, else a band of its own) gets a town hall,
 * finished, two workers beside it, and soldiers for the rest — humans and orcs in turn. A rule of the game, run by the
 * referee on a fresh world (net/referee.ts `setup`).
 */
import type { SimWorld } from "./world.ts";
import { tileCenterFP } from "./components.ts";
import { rngRange } from "./rng.ts";
import { unitTypeId } from "./unitTypes.ts";
import { canPlaceBuilding, spawnBuilding, spawnUnit } from "./world.ts";

export interface MatchSetup {
	"teams": number;
	/** Units per team, its two workers included. */
	"perTeam": number;
	/** Each team's start tile, where the map has one. */
	"starts": [number, number][];
}

export function setupMatch(world: SimWorld, mapW: number, mapH: number, { teams, perTeam, starts }: MatchSetup): void {
	for (let team = 0; team < teams; team += 1) {
		const orc = team % 2 === 1;
		const [sx, sy] = starts[team] ?? [Math.floor(((team + 0.5) / teams) * mapW), Math.floor(mapH / 2)];
		const hallType = unitTypeId(orc ? "unit-great-hall" : "unit-town-hall");
		const [hx, hy] = [Math.min(mapW - 4, Math.max(0, sx - 2)), Math.min(mapH - 4, Math.max(0, sy - 2))];

		if (canPlaceBuilding(world, hx, hy, hallType)) {
			const hall = spawnBuilding(world, hx, hy, team, hallType);

			if (hall !== -1) {
				world.components.Building.buildLeft[hall] = 0;
			}
		}

		for (let placed = 0, tries = 0; placed < perTeam && tries < 1000; tries += 1) {
			const type = unitTypeId(placed < 2 ? (orc ? "unit-peon" : "unit-peasant") : (orc ? "unit-grunt" : "unit-footman"));
			const tx = Math.min(mapW - 1, Math.max(0, sx + rngRange(world, -5, 6)));
			const ty = Math.min(mapH - 1, Math.max(0, sy + rngRange(world, -5, 6)));

			if (world.terrain.pass[ty * mapW + tx] === 0 && world.occupancy[ty * mapW + tx] === 0 && spawnUnit(world, tileCenterFP(tx), tileCenterFP(ty), team, undefined, type) !== -1) {
				placed += 1;
			}
		}
	}
}
