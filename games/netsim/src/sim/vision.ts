/**
 * What a team can see: its own units, plus every other unit within sight of one of them. The referee sends each
 * player exactly this (fog of war is enforced by never sending the rest), so it's also what a player's view hash
 * is computed over.
 */
import type { Unit, World } from "./world.ts";
import { approxDistance } from "./fixed.ts";

export function visibleUnits(world: World, team: number): Unit[] {
	const own = [...world.units.values()].filter((unit) => unit.team === team);
	const { sight } = world.config;

	return [...world.units.values()].filter((unit) => unit.team === team || own.some((viewer) => approxDistance(unit.x - viewer.x, unit.y - viewer.y) <= sight));
}
