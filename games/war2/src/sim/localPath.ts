/**
 * Local unit-aware pathing — the short-range, SUB-TILE half of the two-tier path system.
 *
 * Long-range navigation around terrain is the cached, terrain-only flow field (flowField.ts).  This
 * layer kicks in within LOCAL_RANGE tiles of the goal, where it matters that a mover routes around
 * nearby parked units — including units anchored OFF-CENTRE on the 8px grid, whose diamonds poke into
 * a neighbouring tile/lane.  A tile-level planner can't see that (the unit "is" in the next tile), so
 * this A* runs on the **8px grid** against the settled units' real C-space footprints
 * (pathObstacles.cspaceBlockedCell): a cell is un-enterable if a mover's CENTRE there would overlap a
 * settled unit.  It returns a sub-tile aim point (FP) a short way along the path to steer toward.
 *
 * Combat-safe: no global cache; a bounded per-unit search run only by units near their goal.  Moving
 * units aren't baked in (they'd thrash the path) — they're handled by the reactive collision in the
 * movement system.  Enemy units aren't included either (own-team only, to keep fog honest).
 *
 * Determinism: a pure function of (team, start, goal, terrain, settled C-space).  Generation-stamped
 * scratch avoids per-call allocation and full clears; it's the world's (`world.local`).
 */
import type { Shape } from "./collide.ts";
import type { SimWorld } from "./world.ts";
import { inset } from "./collide.ts";
import { DIR_DX, DIR_DY, MinHeap } from "./flowField.ts";
import { buildingAtIdx } from "./occupancy.ts";
import { cspaceBlockedCell } from "./pathObstacles.ts";
import { getBelievedPassability } from "./vision.ts";
import { terrainClearForPass } from "./walkGrid.ts";

export const LOCAL_RANGE = 6;             // tiles: within this of the goal, steer with the local A*
const CELLS_PER_TILE = 4;             // 8px cells per 32px tile
const RANGE_CELLS = LOCAL_RANGE * CELLS_PER_TILE;   // A* window radius around the goal (cells)
const DIR_COST = [10, 14, 10, 14, 10, 14, 10, 14] as const;
const CLEARANCE_MARGIN = 12000;   // FP: a cell clear for the mover but not for it grown by this is "touching" (low clearance)
const CLEARANCE_PENALTY = 40;      // extra A* cost for a low-clearance cell → prefer margin, allow touching

/** A world's local-path scratch, over its map's 8px cells. */
export interface LocalPathScratch {
	"cW": number;
	"cH": number;
	/** gScore (valid only where stamp === gen). */
	"g": Int32Array;
	/** Parent cell along the best path. */
	"from": Int32Array;
	/** Generation a cell was last touched (0 = never). */
	"stamp": Int32Array;
	/** Path cells walked back from the goal. */
	"path": Int32Array;
	"gen": number;
	"heap": MinHeap;
}

export function createLocalPath(mapW: number, mapH: number): LocalPathScratch {
	const cW = mapW * CELLS_PER_TILE;
	const cH = mapH * CELLS_PER_TILE;
	const size = cW * cH;

	return { "cW": cW, "cH": cH, "g": new Int32Array(size), "from": new Int32Array(size), "stamp": new Int32Array(size), "path": new Int32Array(size), "gen": 0, "heap": new MinHeap(size) };
}

/** Octile distance in cell units (cardinal 10, diagonal 14) → admissible A* heuristic. */
function octile(dx: number, dy: number): number {
	dx = dx < 0 ? -dx : dx; dy = dy < 0 ? -dy : dy;
	const lo = dx < dy ? dx : dy; const
		hi = dx < dy ? dy : dx;

	return 10 * hi + 4 * lo;
}

/** True if a mover of shape `self` centred at (xFP,yFP) is clear of static terrain on this team's
 *  BELIEVED grid.  Delegates to the SAME test the mover uses (walkGrid.terrainClearForPass) so the
 *  planner's route can never permit a path the mover can't walk — the same shapes, identically. */
function terrainClearFP(world: SimWorld, pass: Uint8Array, xFP: number, yFP: number, self: Shape): boolean {
	return terrainClearForPass(world, pass, xFP, yFP, self);
}

/** Cell-centre terrain test for the A* grid (true = blocked for a centre sitting in that cell). */
function terrainCell(world: SimWorld, pass: Uint8Array, cx: number, cy: number, self: Shape): boolean {
	return !terrainClearFP(world, pass, (cx * 8 + 4) * 1000, (cy * 8 + 4) * 1000, self);
}

/** True if the straight segment (ax,ay)→(bx,by) is traversable for a mover of shape `self` — clear of
 *  terrain AND this team's settled-unit C-space.  Drives the string-pull. */
function losClear(world: SimWorld, pass: Uint8Array, team: number, ax: number, ay: number, bx: number, by: number, self: Shape): boolean {
	const dx = bx - ax; const
		dy = by - ay;
	const span = Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy);
	const steps = Math.max(1, (span / 4000) | 0);   // sample ~every 4px

	for (let i = 1; i <= steps; i++) {
		const x = ax + ((dx * i / steps) | 0); const
			y = ay + ((dy * i / steps) | 0);

		if (!terrainClearFP(world, pass, x, y, self)) { return false; }
		if (cspaceBlockedCell(world, team, (x / 8000) | 0, (y / 8000) | 0)) { return false; }
	}

	return true;
}

/** True if one of `team`'s parked units sits on the straight segment (ax,ay)→(bx,by) — its C-space (pathObstacles), so
 *  a mover's centre on the segment would overlap it — leaving out the mover's own 8px cell (a unit touching a parked one
 *  can have its cell flagged).  Terrain isn't asked: the flow field already routes round it. */
export function parkedInTheWay(world: SimWorld, team: number, ax: number, ay: number, bx: number, by: number): boolean {
	const dx = bx - ax; const
		dy = by - ay;
	const span = Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy);
	const steps = Math.max(1, (span / 4000) | 0);   // sample ~every 4px
	const own = ((ay / 8000) | 0) * world.obstacles.cW + ((ax / 8000) | 0);

	for (let i = 1; i <= steps; i++) {
		const cx = ((ax + ((dx * i / steps) | 0)) / 8000) | 0; const
			cy = ((ay + ((dy * i / steps) | 0)) / 8000) | 0;

		if (cy * world.obstacles.cW + cx !== own && cspaceBlockedCell(world, team, cx, cy)) { return true; }
	}

	return false;
}

/**
 * Sub-tile aim point (FP [x,y]) a mover at (uxFP,uyFP) should steer toward to reach (gxFP,gyFP) while
 * routing its CENTRE around this team's settled units' C-space, or null if there's no local route
 * (caller falls back to the flow field).  The start cell is C-space-exempt (the mover may currently
 * touch/overlap a parked unit and must be able to path out).
 */
export function localNextAim(world: SimWorld, team: number, uxFP: number, uyFP: number, gxFP: number, gyFP: number, self: Shape): [number, number] | null {
	const pass = getBelievedPassability(world, team);
	const local = world.local;

	if (!pass || !local) { return null; }
	const { cW, cH, g, from, stamp, path } = local;
	const mapW = world.terrain.w;
	const ucx = Math.floor(uxFP / 8000); const
		ucy = Math.floor(uyFP / 8000);
	const gcx = Math.floor(gxFP / 8000); const
		gcy = Math.floor(gyFP / 8000);

	if (ucx < 0 || ucy < 0 || ucx >= cW || ucy >= cH) { return null; }
	const startIdx = ucy * cW + ucx;
	const goalIdx = gcy * cW + gcx;

	if (startIdx === goalIdx) { return null; }   // already in the goal cell → movement beelines the exact point

    // Terrain is inflated by the mover's footprint (terrainCell); the START cell is exempt so a unit
    // standing legitimately close to a wall can still path out (the continuous collision validates the
    // actual first step anyway).  The GOAL tile only needs to be a passable TILE — a tile-centre goal
    // adjacent to a wall is reachable even though its inflated footprint grazes the wall.
	const blockedTerrain = (cx: number, cy: number): boolean => terrainCell(world, pass, cx, cy, self);
	const wider = inset(self, -CLEARANCE_MARGIN);
	const blocked = (idx: number, cx: number, cy: number): boolean => idx !== startIdx && idx !== goalIdx && (blockedTerrain(cx, cy) || cspaceBlockedCell(world, team, cx, cy));
	const goalTi = (gcy >> 2) * mapW + (gcx >> 2);

	if (pass[goalTi] === 1 || buildingAtIdx(world, goalTi)) { return null; }   // goal on terrain → let the flow field decide

	local.gen += 1;
	const gen = local.gen;
	const heap = local.heap;

	heap.clear();
	g[startIdx] = 0; stamp[startIdx] = gen; from[startIdx] = -1;
	heap.push(octile(gcx - ucx, gcy - ucy), startIdx);

	let found = false;

	while (heap.size > 0) {
		const [f, idx] = heap.pop();

		if (idx === goalIdx) { found = true; break; }
		const x = idx % cW; const
			y = (idx / cW) | 0;
		const gcur = g[idx];

		if (f - octile(gcx - x, gcy - y) > gcur) { continue; }   // stale heap entry

		for (let d = 0; d < 8; d++) {
			const nx = x + DIR_DX[d]; const
				ny = y + DIR_DY[d];

			if (nx < 0 || nx >= cW || ny < 0 || ny >= cH) { continue; }
            // Keep the search bounded to a window around the goal.
			const adx = nx > gcx ? nx - gcx : gcx - nx; const
				ady = ny > gcy ? ny - gcy : gcy - ny;

			if ((adx > ady ? adx : ady) > RANGE_CELLS) { continue; }

			const ni = ny * cW + nx;

			if (blocked(ni, nx, ny)) { continue; }
            // Edge (segment) check: two consecutive "touching"-clear cells can still have a wall poking BETWEEN them, so
            // the edge's midpoint is tested too — with the mover's whole shape, diagonal or not: the stepper takes no
            // centre-only shortcut any more (W6 step 4), and diamond-on-diamond contact keeps a diagonal pinch
            // threadable on its own (exactly touching both walls, as collide.test.ts pins).
			if (idx !== startIdx) {
				const mx = (4 * (x + nx) + 4) * 1000; const
					my = (4 * (y + ny) + 4) * 1000;

				if (!terrainClearFP(world, pass, mx, my, self)) { continue; }
			}

            // Clearance cost: penalise cells the mover can only pass by TOUCHING a wall (clear for its shape but
            // not for it grown by the margin).  The A* then prefers routes with real clearance — so it doesn't skim an
            // obstacle's edge into a touching-boundary freeze — yet still uses touching cells when they're
            // the only way through (a pinch / 1-tile gap), where the uniform penalty doesn't change the route.
			const wide = terrainClearFP(world, pass, (nx * 8 + 4) * 1000, (ny * 8 + 4) * 1000, wider);
			const ng = gcur + DIR_COST[d] + (wide ? 0 : CLEARANCE_PENALTY);

			if (stamp[ni] !== gen || ng < g[ni]) {
				g[ni] = ng; from[ni] = idx; stamp[ni] = gen;
				heap.push(ng + octile(gcx - nx, gcy - ny), ni);
			}
		}
	}

	if (!found) { return null; }

    // Walk the parent chain back from the goal into path[0..len) (goal → … → start).
	let len = 0; let
		cur = goalIdx;

	while (cur !== -1 && len < path.length) { path[len] = cur; len += 1; cur = from[cur]; }

    // String-pull: steer at the FURTHEST path waypoint with clear line-of-sight from the unit — one
    // follower for every case.  It cuts straight across open ground; where terrain/units constrain LOS
    // (gap, pinch, corner) it falls back to the nearest reachable waypoint, funnelling through the
    // corridor centre.  (path[0] = goal, [len-1] = start.)  Re-planned each tick, so the aim advances.
	for (let i = 0; i < len - 1; i++) {
		const c = path[i];
		const wx = ((c % cW) * 8 + 4) * 1000; const
			wy = (((c / cW) | 0) * 8 + 4) * 1000;

		if (losClear(world, pass, team, uxFP, uyFP, wx, wy, self)) { return [wx, wy]; }
	}

	const aimIdx = path[len - 2 >= 0 ? len - 2 : 0];   // nothing visible → next cell along the path

	return [((aimIdx % cW) * 8 + 4) * 1000, (((aimIdx / cW) | 0) * 8 + 4) * 1000];
}
