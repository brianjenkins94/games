/**
 * Path obstacles — a per-team 8px **C-SPACE** grid of cells a moving unit's CENTRE can't occupy
 * without overlapping one of that team's *settled* (idle) units.  This is what makes the local A*
 * (localPath.ts) sub-tile-aware: it routes a mover's centre around the real diamond footprints —
 * including units anchored OFF-CENTRE that poke into a neighbouring tile/lane, which a tile-level
 * obstacle map can't see.
 *
 * Why C-space (obstacle grown by the mover's radius) rather than the live walk-grid reservations:
 * only SETTLED units are stable enough to plan around (baking in movers would thrash the path);
 * own-team only (routing around enemies would leak fog — enemy avoidance is the continuous collision
 * in systems/movement.ts).
 *
 * Determinism: a pure function of which units are settled and where.  Rebuilt from world state at
 * deterministic points (tick boundary / command application) and after snapshot restore, so host and
 * guest agree.  Plain storage — the rebuild scan lives in world.ts (which can iterate the ECS). It's the world's
 * (`world.obstacles`).
 */
import type { SimWorld } from "./world.ts";

const WALK_PX = 8;

/** A world's path obstacles: the C-space grid size in 8px cells, each team's grid, and whether the idle set may have
 *  changed since they were built. */
export interface PathObstacles {
	"cW": number;
	"cH": number;
	/** team → 8px C-space occupancy (1 = a mover's centre here overlaps a settled unit). */
	"grids": Map<number, Uint8Array>;
	/** The idle set may have changed → grids need a rebuild. */
	"dirty": boolean;
}

export function createPathObstacles(mapW: number, mapH: number): PathObstacles {
	return { "cW": mapW * (32 / WALK_PX), "cH": mapH * (32 / WALK_PX), "grids": new Map(), "dirty": true };
}

/** Flag that the settled-unit set may have changed (a unit settled / started moving / spawned / died). */
export function markIdleDirty(world: SimWorld): void { world.obstacles.dirty = true; }

/** Clear every team's grid — called at the start of a rebuild. */
export function resetIdleGrids(world: SimWorld): void { for (const g of world.obstacles.grids.values()) { g.fill(0); } }

/** Stamp the C-SPACE diamond of a settled unit at world centre (xPx,yPx): every 8px cell whose centre
 *  is within L1 `sumPx` (= mover radius + settled radius) is un-enterable for a mover's centre.  Strict
 *  `<` so touching (L1 == sum) stays free — a mover may path right up against a settled unit, just not
 *  overlap it.  Deterministic integer. */
export function addIdleCSpace(world: SimWorld, team: number, xPx: number, yPx: number, sumPx: number): void {
	const { cW, cH, grids } = world.obstacles;
	let g = grids.get(team);

	if (!g) { g = new Uint8Array(cW * cH); grids.set(team, g); }
	const cx0 = Math.max(0, Math.floor((xPx - sumPx) / WALK_PX));
	const cx1 = Math.min(cW - 1, Math.floor((xPx + sumPx) / WALK_PX));
	const cy0 = Math.max(0, Math.floor((yPx - sumPx) / WALK_PX));
	const cy1 = Math.min(cH - 1, Math.floor((yPx + sumPx) / WALK_PX));

	for (let cy = cy0; cy <= cy1; cy++) {
		const dyc = Math.abs((cy * WALK_PX + WALK_PX / 2) - yPx);

		if (dyc >= sumPx) { continue; }
		for (let cx = cx0; cx <= cx1; cx++) {
			const dxc = Math.abs((cx * WALK_PX + WALK_PX / 2) - xPx);

			if (dxc + dyc < sumPx) { g[cy * cW + cx] = 1; }
		}
	}
}

/** True if a mover's centre at 8px cell (cx,cy) would overlap one of `team`'s settled units. */
export function cspaceBlockedCell(world: SimWorld, team: number, cx: number, cy: number): boolean {
	return world.obstacles.grids.get(team)?.[cy * world.obstacles.cW + cx] === 1;
}
