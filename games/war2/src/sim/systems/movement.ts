/**
 * Movement system — "WC2 atop SC": an SC-style avoidance base with a WC2-style tile layer for rest.
 *
 *   • Avoidance base (while moving): a unit steers toward an aim chosen by the pathing (long-range
 *     terrain flow field + short-range unit-aware local A*), reserving its walk cells so others see
 *     it.  Sub-tile move per tick, under ONE rule for what blocks it — terrain, buildings and parked units,
 *     touching allowed (collide.ts shapes; moving traffic is passed through) — the planner's rule too (W6):
 *       – the aimed step, if clear.  Unit↔unit collision is a DIAMOND, so its slim diagonals let a unit
 *         thread the gap between two diagonally-placed units — exactly touching both (the razor).
 *       – else the best slide (stepToward): the step's clear part, or a full-speed slide along an axis or a
 *         diagonal, whichever gets closest to the aim — stopping exactly at contact, so the next tick
 *         slides along the touching face (how it threads a razor or a diagonal wall pinch).
 *       – lane-centre: ride the tile-lane centre so a full-tile unit fits a 1-tile cardinal gap (off-centre,
 *         the perpendicular nudge truncates to 0 and the unit stalls).
 *
 *   • Tile layer (at rest): when a unit arrives (or goes STUCK_LIMIT ticks without progress)
 *     it snaps onto the nearest tile centre free of other units and reserves it (see settleOnto).
 *     Because each unit is handed a distinct tile target (formation offset / gather slot — see
 *     world.ts), the group comes to rest one-per-tile: grid-crisp and never stacked.
 *
 * `stuckTicks` drives the escalation and is keyed on *goal progress*: only coming closer than the unit ever has since
 * its order — in a straight line to its slot (by PROGRESS_EPS) or along its route (its flow field's cost to go) —
 * resets it (Path.bestDist / bestCost).  Moving without beating either, waiting, or being pushed out of an overlap do
 * not — so it climbs to STUCK_LIMIT (settle).  Keying on
 * the best so far, not on "did this tick's step succeed" or "did it gain on last tick" (W6): a unit stepping into a
 * parked unit and being pushed back out "succeeded" and "gained" every other tick, and jittered there forever.  This
 * replaced an earlier hard-reservation model whose every-tick no-overlap rule needed a pile of special cases
 * (slide/slip/wait, far-first, loiter, settle guards).
 *
 * Determinism: integer fixed-point throughout; magnitudes via the sqrt-free dodecagon distance().
 * Reservation is order-dependent but the referee processes units in a stable eid order that
 * snapshot/replay reproduces.  UnitAnim is render-only (excluded from hash).
 */

import type { Shape } from "../collide.ts";
import type { SimWorld } from "../world.ts";
import { hasComponent } from "bitecs";
import { unitShape } from "../collide.ts";
import { FP, fpToTile, snapWalkFP, TILE_PX, tileCenterFP, UNIT_SPD } from "../components.ts";
import { distance, octant } from "../distance.ts";
import type { FlowField } from "../flowField.ts";
import { DIR_DX, DIR_DY, getOrComputeFlowField, INF, UNREACHABLE } from "../flowField.ts";
import { LOCAL_RANGE, localNextAim, parkedInTheWay } from "../localPath.ts";
import { markIdleDirty } from "../pathObstacles.ts";
import { getBelievedPassability } from "../vision.ts";
import { unitEids } from "../world.ts";
import { footprintSoftFreeAt, freeUnit, reserveUnit, separateFrom, terrainClearForPass } from "../walkGrid.ts";

// ── Tunables ──────────────────────────────────────────────────────────────────
const ARRIVE_FP = 2 * FP;          // within this of the goal point → settle.  Small, because the
                                      // collision-off final approach walks the unit ~exactly onto the
                                      // centre, so settle's snap is a ≤2px no-op (no visible grid-pop).
const PROGRESS_EPS = UNIT_SPD >> 1;   // min straight-line gain on the best so far to count as "progress"
const STUCK_LIMIT = 36;              // ticks without progress before settling nearby
const DETOUR_AFTER = 3;              // ticks without progress before planning locally round whatever's in the way
const SETTLE_R = 5;               // tiles: how far to look for a free rest tile when settling
const NEAR_GOAL_FP = 48 * FP;         // ≤1.5 tiles from goal + blocked → snap onto the (free) goal tile

const clampTile = (t: number, n: number) => (t < 0 ? 0 : t >= n ? n - 1 : t);

/** Move `delta` capped to a per-axis `budget` (≥0), exact when within it — no normalise/truncate, so a
 *  sub-pixel lane correction never rounds away to zero (which would asymptote a unit at a 1-tile gap). */
function clampStep(delta: number, budget: number): number {
	return budget <= 0 ? 0 : delta > budget ? budget : delta < -budget ? -budget : delta;
}

/** A new order: no progress made yet, nothing to beat (Path.bestDist / bestCost). */
export function resetProgress(world: SimWorld, eid: number): void {
	const { Path } = world.components;

	Path.stuckTicks[eid] = 0;
	Path.bestDist[eid] = INF;
	Path.bestCost[eid] = INF;
	Path.lastCost[eid] = INF;
}

/** A tick without progress: count it, and settle nearby once boxed in too long (STUCK_LIMIT). */
function noProgress(world: SimWorld, eid: number, self: Shape): void {
	const { Path } = world.components;

	Path.stuckTicks[eid] += 1;

	if (Path.stuckTicks[eid] >= STUCK_LIMIT) {
		settleOnto(world, eid, self);
	}
}

/** The furthest a unit of shape `self` at (x,y) can go along (cx,cy) — the whole of it, or the clear part — without
 *  overlapping terrain, a building or a parked unit: [dx, dy].  Binary search over the integer fraction, so a unit
 *  blocked short of the full step stops exactly touching (strict overlap: touching is clear) — which is what lets the
 *  next tick's slide run along the touching face. */
function advance(world: SimWorld, eid: number, self: Shape, x: number, y: number, cx: number, cy: number, yieldTo?: YieldTo): [number, number] {
	const span = Math.max(Math.abs(cx), Math.abs(cy));

	if (span === 0) { return [0, 0]; }
	if (footprintSoftFreeAt(world, x + cx, y + cy, self, eid, yieldTo)) { return [cx, cy]; }
	let lo = 0; let
		hi = span;   // clear at lo/span of the step, not at hi/span

	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;

		if (footprintSoftFreeAt(world, x + Math.trunc(cx * mid / span), y + Math.trunc(cy * mid / span), self, eid, yieldTo)) { lo = mid; } else { hi = mid; }
	}

	return [Math.trunc(cx * lo / span), Math.trunc(cy * lo / span)];
}

/** Which moving units block this one, as parked units do (footprintSoftFreeAt). */
type YieldTo = (other: number) => boolean;

/** Taking turns (W6 step 6): a unit yields to a moving teammate further along its route — a lower cost to go at its tile
 *  (Path.lastCost, last tick's), ties to the lower stable id.  A total order, so no two units wait on each other: the
 *  one ahead passes through those behind as every mover did before, and those behind queue rather than pile onto it. */
function yieldsTo(world: SimWorld, eid: number): YieldTo {
	const { MoveTarget, Path, Unit, UnitId } = world.components;

	return (other) => MoveTarget.active[other] === 1 && Unit.team[other] === Unit.team[eid]
		&& (Path.lastCost[other] < Path.lastCost[eid] || (Path.lastCost[other] === Path.lastCost[eid] && UnitId.id[other] < UnitId.id[eid]));
}

/** A diagonal step's leg, at full speed (the dodecagon distance of (k, k) is UNIT_SPD). */
const DIAGONAL_LEG = Math.trunc(UNIT_SPD * UNIT_SPD / distance(UNIT_SPD, UNIT_SPD));

/** The steps a unit at (x,y) wanting (sx,sy) toward (aimX,aimY) may take when the step itself is blocked: the step's
 *  clear part, a full-speed slide along each axis toward the aim, and along each diagonal but the one straight away. */
function slides(x: number, y: number, sx: number, sy: number, aimX: number, aimY: number): [number, number][] {
	const toX = aimX > x ? 1 : -1; const
		toY = aimY > y ? 1 : -1;

	return [[sx, sy], [clampStep(aimX - x, UNIT_SPD), 0], [0, clampStep(aimY - y, UNIT_SPD)], [toX * DIAGONAL_LEG, toY * DIAGONAL_LEG], [toX * DIAGONAL_LEG, -toY * DIAGONAL_LEG], [-toX * DIAGONAL_LEG, toY * DIAGONAL_LEG]];
}

/** The best single slide from (x,y): where it lands and how much closer to the aim (0 and staying put if none gains). */
function bestSlide(world: SimWorld, eid: number, self: Shape, x: number, y: number, sx: number, sy: number, aimX: number, aimY: number, yieldTo?: YieldTo): [number, number, number] {
	const before = distance(aimX - x, aimY - y);
	let best: [number, number, number] = [x, y, 0];

	for (const [cx, cy] of slides(x, y, sx, sy, aimX, aimY)) {
		const [dx, dy] = advance(world, eid, self, x, y, cx, cy, yieldTo);
		const gain = before - distance(aimX - x - dx, aimY - y - dy);

		if (gain > best[2]) { best = [x + dx, y + dy, gain]; }
	}

	return best;
}

/** One step for a unit at (x,y) wanting (sx,sy) toward its aim: the step itself if clear; else the slide that brings it
 *  closest to the aim.  If no slide gains more than a sliver — boxed in, or at a razor it's not quite lined up with —
 *  look one step further: take the first of the two slides that gain most together, even if the first gains nothing by
 *  itself (lining up with the gap between two parked units, exactly touching both, so the next can go through).
 *  None gains → it waits, and its stuck count climbs.  Ties go to the first candidate, so it's deterministic. */
function stepToward(world: SimWorld, eid: number, self: Shape, x: number, y: number, sx: number, sy: number, aimX: number, aimY: number, yieldTo?: YieldTo): [number, number] {
	if ((sx !== 0 || sy !== 0) && footprintSoftFreeAt(world, x + sx, y + sy, self, eid, yieldTo)) { return [x + sx, y + sy]; }
	const [bx, by, gain] = bestSlide(world, eid, self, x, y, sx, sy, aimX, aimY, yieldTo);

	if (gain >= PROGRESS_EPS) { return [bx, by]; }
	const before = distance(aimX - x, aimY - y);
	let best: [number, number, number] = [bx, by, gain];

	for (const [cx, cy] of slides(x, y, sx, sy, aimX, aimY)) {
		const [dx, dy] = advance(world, eid, self, x, y, cx, cy, yieldTo);

		if (dx === 0 && dy === 0) { continue; }
		const [, , then] = bestSlide(world, eid, self, x + dx, y + dy, sx, sy, aimX, aimY, yieldTo);
		const total = before - distance(aimX - x - dx, aimY - y - dy) + then;

		if (total > best[2]) { best = [x + dx, y + dy, total]; }
	}

	return [best[0], best[1]];
}

/** Round a parked unit in the flow's way (W6 step 5): the flow field sees only terrain and buildings, so where one of
 *  the team's parked units sits on the next stretch of the route, plan round it with the local A* — to the farthest
 *  tile of the route up to LOCAL_RANGE-1 ahead whose centre is clear of parked units, where the unit rejoins the flow.
 *  Null if there's no such tile or no local route (the unit keeps to the flow, and its stuck count settles it). */
function detourAim(world: SimWorld, eid: number, self: Shape, dirs: Uint8Array, curTx: number, curTy: number): [number, number] | null {
	const { Position, Unit } = world.components;
	const mapW = world.terrain.w;
	const team = Unit.team[eid];
	let [tx, ty] = [curTx, curTy];
	let rejoin: [number, number] | null = null;

	for (let ahead = 1; ahead < LOCAL_RANGE; ahead++) {
		const dir = dirs[ty * mapW + tx];

		if (dir === UNREACHABLE) { break; }   // the goal (or nowhere): the route ends here
		tx += DIR_DX[dir]; ty += DIR_DY[dir];

		const cx = tileCenterFP(tx); const
			cy = tileCenterFP(ty);

		if (!parkedInTheWay(world, team, cx, cy, cx, cy + 1)) { rejoin = [cx, cy]; }
	}

	return rejoin === null ? null : localNextAim(world, team, Position.x[eid], Position.y[eid], rejoin[0], rejoin[1], self);
}

/** Travel as a block (W6 step 6): a unit in a group steers by the group's one shared field from its own place in the
 *  formation — its offset from the group's destination (its slot less the shared goal tile's centre).  It reads the
 *  field where it would be without the offset, and aims at the next tile there shifted back by the offset: so the block
 *  keeps its shape in the open for the cost of one Dijkstra, rather than every unit funnelling onto the field's one
 *  lane (group-open's 3×3 was a single overlapping file by tick 40).  Where the shifted point isn't clear ground, half
 *  the offset; where even that isn't, null — the unit follows the field itself, single file, as through a gap.  Null for
 *  a unit alone (its slot IS the goal: no offset).  Returns the aim and the field's step [dx, dy] (for lane-riding). */
function formationAim(world: SimWorld, eid: number, self: Shape, field: FlowField): [number, number, number, number] | null {
	const { MoveTarget, Path, Position, Unit } = world.components;
	const { w: mapW, h: mapH } = world.terrain;
	const offX = MoveTarget.tx[eid] - tileCenterFP(Path.goalTx[eid]); const
		offY = MoveTarget.ty[eid] - tileCenterFP(Path.goalTy[eid]);

	if (Math.abs(offX) + Math.abs(offY) < TILE_PX * FP) { return null; }   // alone, or the group's middle: no offset
	const vtx = fpToTile(Position.x[eid] - offX); const
		vty = fpToTile(Position.y[eid] - offY);

	if (vtx < 0 || vty < 0 || vtx >= mapW || vty >= mapH) { return null; }
	const dir = field.dirs[vty * mapW + vtx];

	if (dir === UNREACHABLE) { return null; }
	const pass = getBelievedPassability(world, Unit.team[eid]);
	const [x, y] = [Position.x[eid], Position.y[eid]];
	const here = field.cost[fpToTile(y) * mapW + fpToTile(x)];

	for (const share of [2, 1]) {   // the whole offset, then half
		const ax = Math.trunc(tileCenterFP(vtx + DIR_DX[dir]) + offX * share / 2); const
			ay = Math.trunc(tileCenterFP(vty + DIR_DY[dir]) + offY * share / 2);
		const atx = fpToTile(ax); const
			aty = fpToTile(ay);

		// Clear ground, forward on the unit's OWN route (a field step that doesn't bring it closer — along a wall away from
		// the gap the block is narrowing to — is no place to hold), and a straight line there.
		if (atx < 0 || aty < 0 || atx >= mapW || aty >= mapH || field.cost[aty * mapW + atx] >= here) { continue; }
		if (terrainClearForPass(world, pass, ax, ay, self) && terrainClearForPass(world, pass, (x + ax) >> 1, (y + ay) >> 1, self)) { return [ax, ay, DIR_DX[dir], DIR_DY[dir]]; }
	}

	return null;
}

/** How near its slot a unit must be for a parked unit on it to send it to another (2 tiles): far off, the slot may
 *  well be free by the time it gets there. */
const RESLOT_NEAR_FP = 2 * TILE_PX * FP;

/** Give a unit another slot if its own is one it can't have: unreachable by the group's flow field (cost to go
 *  infinite — not its own goal tile, which is 0), or, within RESLOT_NEAR_FP, held by a parked unit.  The new slot is the
 *  nearest tile to the old, ring by ring out to SETTLE_R, that the field reaches and a unit of its shape can stand on;
 *  its straight-line best starts over (its route's doesn't: the field is the same).  False if it keeps its slot. */
function reslot(world: SimWorld, eid: number, self: Shape, x: number, y: number): boolean {
	const { MoveTarget, Path, Unit } = world.components;
	const { w: mapW, h: mapH } = world.terrain;
	const field = getOrComputeFlowField(world, Unit.team[eid], Path.goalTx[eid], Path.goalTy[eid]);

	if (!field) { return false; }
	const gx = MoveTarget.tx[eid]; const
		gy = MoveTarget.ty[eid];
	const stx = clampTile(fpToTile(gx), mapW); const
		sty = clampTile(fpToTile(gy), mapH);
	const unreachable = field.cost[sty * mapW + stx] === INF;
	const taken = !unreachable && distance(gx - x, gy - y) <= RESLOT_NEAR_FP && !footprintSoftFreeAt(world, gx, gy, self, eid);

	if (!unreachable && !taken) { return false; }

	for (let ring = 1; ring <= SETTLE_R; ring++) {
		for (let dy = -ring; dy <= ring; dy++) {
			for (let dx = -ring; dx <= ring; dx++) {
				const tx = stx + dx; const
					ty = sty + dy;

				if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring || tx < 0 || ty < 0 || tx >= mapW || ty >= mapH || field.cost[ty * mapW + tx] === INF) { continue; }
				if (!footprintSoftFreeAt(world, tileCenterFP(tx), tileCenterFP(ty), self, eid)) { continue; }
				MoveTarget.tx[eid] = tileCenterFP(tx); MoveTarget.ty[eid] = tileCenterFP(ty);
				Path.bestDist[eid] = INF;

				return true;
			}
		}
	}

	return false;
}

/** Halt a unit: clear movement, path and animation state in one place.
 *  The unit keeps its current walk-cell reservation (it just stops on it). */
export function stopUnit(world: SimWorld, eid: number): void {
	const { MoveTarget, Path, UnitAnim } = world.components;

	MoveTarget.active[eid] = 0;
	Path.active[eid] = 0;
	Path.stuckTicks[eid] = 0;
	UnitAnim.moving[eid] = 0;
	markIdleDirty(world);   // a settled unit joins the path-obstacle set (flow fields route around it)
}

/** Bring a unit to rest.  The unit has walked (collision-off final approach) onto its goal, which is
 *  an 8px-grid-aligned position, so we rest it RIGHT THERE — no 32px tile-centre snap (that would undo
 *  sub-tile anchoring).  We just snap the rest point to the 8px grid (`snapWalkFP`, a ≤4px no-op after
 *  the walk) so a 32px box lands on 4 whole cells, and check it's free of other *settled* units
 *  (footprintSoftFreeAt ignores movers, so a mate still converging doesn't bump us).
 *
 *  If that spot is TAKEN (a genuine, e.g. converge, conflict), the unit must rest on a different tile —
 *  but it WALKS there as a normal move rather than snapping Position across a whole tile.  An instant
 *  one-tile Position jump is the "unit zooms into a space different from where it looked like it'd land"
 *  pop: the sprite was gliding to its goal, then the sim teleports it.  Walking keeps it continuous. */
function settleOnto(world: SimWorld, eid: number, self: Shape, restX = world.components.Position.x[eid], restY = world.components.Position.y[eid]): void {
	const { Position } = world.components;

	freeUnit(world, eid);
	const bx = snapWalkFP(restX); const
		by = snapWalkFP(restY);   // 8px-aligned rest base
	const STEP = TILE_PX * FP;

	for (let ring = 0; ring <= SETTLE_R; ring++) {
		for (let dy = -ring; dy <= ring; dy++) {
			for (let dx = -ring; dx <= ring; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) { continue; }
				const fx = bx + dx * STEP; const
					fy = by + dy * STEP;

				if (footprintSoftFreeAt(world, fx, fy, self, eid)) {
					Position.x[eid] = fx; Position.y[eid] = fy;
					reserveUnit(world, eid); stopUnit(world, eid);

					return;
				}
			}
		}
	}

	reserveUnit(world, eid); stopUnit(world, eid);   // nothing free nearby → rest where we are (last resort)
}

/** Move a unit standing somewhere it can't be (inside terrain or a building) to the nearest spot it can, by the same
 *  ring search as settling — but it keeps its order.  Out to SETTLE_R tiles; nothing there, it stays. */
function ejectOnto(world: SimWorld, eid: number, self: Shape): void {
	const { Position } = world.components;
	const bx = snapWalkFP(Position.x[eid]); const
		by = snapWalkFP(Position.y[eid]);
	const STEP = TILE_PX * FP;

	freeUnit(world, eid);

	for (let ring = 1; ring <= SETTLE_R; ring++) {
		for (let dy = -ring; dy <= ring; dy++) {
			for (let dx = -ring; dx <= ring; dx++) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring || !footprintSoftFreeAt(world, bx + dx * STEP, by + dy * STEP, self, eid)) { continue; }
				Position.x[eid] = bx + dx * STEP; Position.y[eid] = by + dy * STEP;
				reserveUnit(world, eid);

				return;
			}
		}
	}

	reserveUnit(world, eid);
}

export function movementSystem(world: SimWorld): void {
	const { Building, MoveTarget, Path, Position, Unit } = world.components;
	const mapW = world.terrain.w;
	const mapH = world.terrain.h;

    // Pre-map dev mode (no terrain / no walk grid): direct movement, no collision.
	if (mapW === 0) {
		movePreMap(world);

		return;
	}

	for (const eid of unitEids(world)) {
		if (hasComponent(world, eid, Building)) { continue; }   // buildings: static, never move

		if (Unit.movable[eid] === 1 && MoveTarget.active[eid] === 1) {
			stepUnit(world, eid, mapW, mapH);
		}

        // Refresh the tile the unit sits in (drives flow-field & vision sampling).
		Path.curTx[eid] = clampTile(fpToTile(Position.x[eid]), mapW);
		Path.curTy[eid] = clampTile(fpToTile(Position.y[eid]), mapH);
	}
}

/** Steer one active unit one step toward its planned aim (the aimed step, else the best slide); settle onto a free
 *  tile on arrival or after too long without progress.  See the module header for the stuckTicks escalation. */
function stepUnit(world: SimWorld, eid: number, mapW: number, mapH: number): void {
	const { MoveTarget, Path, Position, Unit, UnitAnim } = world.components;
	const x = Position.x[eid]; const
		y = Position.y[eid];
	let goalX = MoveTarget.tx[eid]; let
		goalY = MoveTarget.ty[eid];
	const self = unitShape(Unit.type[eid]);   // its collision shape (collide.ts)

    // Inside terrain or a building (one was placed on it — the placement check sees only buildings): out to the nearest
    // clear spot, as WC2 moves units off a site; not progress, like a push-out.
	if (!terrainClearForPass(world, world.terrain.pass, x, y, self)) {
		ejectOnto(world, eid, self);
		noProgress(world, eid, self);

		return;
	}

    // De-penetrate first: if we're overlapping a settled unit — which movement itself never does now (it steps only
    // where the one rule allows), so it came from outside: a spawn on top of another, a unit settling onto us while we
    // passed through it — push back OUT along the separation normal and spend the tick on that.
	const sep = separateFrom(world, x, y, self, eid);

	if (sep[0] !== 0 || sep[1] !== 0) {
		freeUnit(world, eid);
		Position.x[eid] = x + sep[0]; Position.y[eid] = y + sep[1];
		reserveUnit(world, eid);
		UnitAnim.moving[eid] = 1;
		UnitAnim.dir[eid] = octant(sep[0], sep[1]);
		noProgress(world, eid, self);   // pushed out, not closer: a unit jittering in and out of a parked one gets nowhere

		return;
	}

	// A slot it can't have — one the group's field can't reach (walled off, often found so in the fog), or, close by, one
	// a parked unit holds (three sent to one point; a rally point already taken): the nearest the field reaches that's
	// free, walked to like any slot (W6 step 7).
	if (reslot(world, eid, self, x, y)) {
		goalX = MoveTarget.tx[eid]; goalY = MoveTarget.ty[eid];
	}

	const prevDist = distance(goalX - x, goalY - y);

	if (prevDist <= ARRIVE_FP) {
		settleOnto(world, eid, self);

		return;
	}   // arrived → rest on a free tile

    // Aim point.  Two-tier pathing all the way to the goal TILE: within LOCAL_RANGE a bounded, SUB-TILE
    // (8px) unit-aware A* routes the unit's centre around settled units' real C-space footprints
    // (localPath.ts) — so it goes AROUND a unit anchored off-centre that pokes into its lane, not into
    // it; farther out the cached terrain-only flow field gives the direction.  Only once the unit is
    // standing IN the goal tile does it beeline the exact (sub-tile, 8px-anchored) goal point.
	const curTx = fpToTile(x); const
		curTy = fpToTile(y);
    // Path.goalTx/goalTy is the SHARED flow-field goal (group destination — one cached field for the whole
    // group); slotTx/slotTy is THIS unit's own final slot, derived from its MoveTarget point.  The unit
    // rides the shared field toward the destination, then the local layer (within LOCAL_RANGE of the slot)
    // peels it onto its own slot — travel-as-a-block, reorganise-into-formation-on-arrival.
	const goalTx = Path.goalTx[eid]; const
		goalTy = Path.goalTy[eid];
	const slotTx = fpToTile(goalX); const
		slotTy = fpToTile(goalY);
	let aimX = goalX; let
		aimY = goalY;
	let laneAxis = 0;     // flow steering a CARDINAL move: 1 = vertical (centre on X lane), 2 = horizontal (Y)
	let corridor = false; // driving along a committed pinch corridor (recentre onto the line, then thread)

	if (!(curTx === slotTx && curTy === slotTy)) {
        // (1) Committed to a pinch corridor → drive to its exit-tile CENTRE; don't re-sample the flow (so
        //     the tile-boundary direction flip and the 4-corner sampling singularity can't wedge it).
		if (Path.wpActive[eid] === 1) {
			const wcx = tileCenterFP(Path.wpTx[eid]); const
				wcy = tileCenterFP(Path.wpTy[eid]);

			if (distance(wcx - x, wcy - y) <= ARRIVE_FP) { Path.wpActive[eid] = 0; }   // arrived → resume
			else { aimX = wcx; aimY = wcy; corridor = true; }
		}

		if (Path.wpActive[eid] === 0) {
			const near = Math.abs(curTx - slotTx) <= LOCAL_RANGE && Math.abs(curTy - slotTy) <= LOCAL_RANGE;
			const localAim = near ? localNextAim(world, Unit.team[eid], x, y, goalX, goalY, self) : null;

			if (localAim) {
				aimX = localAim[0]; aimY = localAim[1];
			} else {
				const ff = getOrComputeFlowField(world, Unit.team[eid], goalTx, goalTy);

				if (!ff) {
					settleOnto(world, eid, self);

					return;
				}

				const flowDir = ff.dirs[curTy * mapW + curTx];

				// Plan locally round what's in the way: a parked unit on the next stretch of the route, or — whatever it is
				// (a parked unit off that line, a corner) — once the unit's gone DETOUR_AFTER ticks without progress.
				const blocked = flowDir !== UNREACHABLE && (Path.stuckTicks[eid] >= DETOUR_AFTER || parkedInTheWay(world, Unit.team[eid], x, y, tileCenterFP(curTx + DIR_DX[flowDir]), tileCenterFP(curTy + DIR_DY[flowDir])));
				const detour = blocked ? detourAim(world, eid, self, ff.dirs, curTx, curTy) : null;

				const block = detour ? null : formationAim(world, eid, self, ff);

				if (detour) {
					aimX = detour[0]; aimY = detour[1];   // a parked unit on the route: round it (local A*), then rejoin
				} else if (block) {
					[aimX, aimY] = block;                 // in a group, in the open: keep its place in the block
					if (block[2] === 0) { laneAxis = 1; } else if (block[3] === 0) { laneAxis = 2; }
				} else if (flowDir !== UNREACHABLE) {
					const dxd = DIR_DX[flowDir]; const
						dyd = DIR_DY[flowDir];
					const pass = getBelievedPassability(world, Unit.team[eid]);
					const pinch = dxd !== 0 && dyd !== 0 && Boolean(pass)
						&& pass[curTy * mapW + (curTx + dxd)] === 1 && pass[(curTy + dyd) * mapW + curTx] === 1;

					if (pinch) {                                   // commit to threading the pinch corridor
						Path.wpActive[eid] = 1;
						Path.wpFromTx[eid] = curTx; Path.wpFromTy[eid] = curTy;
						Path.wpTx[eid] = curTx + dxd; Path.wpTy[eid] = curTy + dyd;
						aimX = tileCenterFP(curTx + dxd); aimY = tileCenterFP(curTy + dyd); corridor = true;
					} else {
						aimX = tileCenterFP(curTx + dxd); aimY = tileCenterFP(curTy + dyd);
						if (dxd === 0) { laneAxis = 1; }        // moving N/S → ride the X lane centre
						else if (dyd === 0) { laneAxis = 2; }   // moving E/W → ride the Y lane centre
					}
				}
                // UNREACHABLE → aim straight at the goal (best effort).
			}
		}
	} else {
		Path.wpActive[eid] = 0;   // in the goal tile → drop any stale commitment
	}

    // Step toward the aim.  A CARDINAL flow step must ride its tile-lane centre to fit a 1-tile gap:
    // off-centre, the wall on the lane edge blocks the forward move while the perpendicular correction
    // normalises to a sub-pixel value that truncates to 0 — the unit asymptotes at the wall forever.  So
    // spend the per-tick budget on cross-axis alignment FIRST (exact within one step), then forward with
    // what's left.  Diagonal flow / goal-tile beeline keep the plain isotropic step.
	let sx: number, sy: number;

	if (corridor) {
        // Thread the pinch corridor: the safe line runs through the source & exit tile centres (a zero-
        // width diagonal lane).  Get ONTO that line first (cancel the perpendicular offset by steering to
        // the projection of the unit onto it), then move along it at 45° toward the exit centre.  Staying
        // on the line is what lets the mover's corner-cut tier graze the flanking walls without wedging.
		const fcx = tileCenterFP(Path.wpFromTx[eid]); const
			fcy = tileCenterFP(Path.wpFromTy[eid]);
		const ldx = aimX >= fcx ? 1 : -1; const
			ldy = aimY >= fcy ? 1 : -1;          // corridor direction (±1,±1)
		const perp = (x - fcx) * ldy - (y - fcy) * ldx;                         // 0 ⇔ on the line

		if (perp !== 0) {
            // Project onto the corridor SEGMENT (not the infinite line): clamp so the recentre target
            // stays between source and exit centres — never behind the source (which can be off-map).
			const lenA = (((aimX - fcx) * ldx + (aimY - fcy) * ldy) / 2) | 0;   // dest's along-scalar (≥0)
			let along = (((x - fcx) * ldx + (y - fcy) * ldy) / 2) | 0;

			along = along < 0 ? 0 : along > lenA ? lenA : along;
			const projX = fcx + along * ldx; const
				projY = fcy + along * ldy;         // nearest point on the segment

			sx = clampStep(projX - x, UNIT_SPD);
			sy = clampStep(projY - y, UNIT_SPD - Math.abs(sx));
		} else {
			const m = Math.min(UNIT_SPD, Math.abs(aimX - x), Math.abs(aimY - y)) || UNIT_SPD;

			sx = (aimX > x ? 1 : aimX < x ? -1 : 0) * m;                        // 45° along the line
			sy = (aimY > y ? 1 : aimY < y ? -1 : 0) * m;
		}
	} else if (laneAxis === 1) {    // vertical move: align X (cross) first, then Y (forward)
		sx = clampStep(aimX - x, UNIT_SPD);
		sy = clampStep(aimY - y, UNIT_SPD - Math.abs(sx));
	} else if (laneAxis === 2) {    // horizontal move: align Y (cross) first, then X (forward)
		sy = clampStep(aimY - y, UNIT_SPD);
		sx = clampStep(aimX - x, UNIT_SPD - Math.abs(sy));
	} else {
		sx = aimX - x; sy = aimY - y;
		const d = distance(sx, sy);

		if (d > UNIT_SPD) {
			sx = (sx * UNIT_SPD / d) | 0;
			sy = (sy * UNIT_SPD / d) | 0;
		}
	}

    // Move (free self first so it isn't its own obstacle).  One rule says what blocks a mover — terrain, buildings and
    // PARKED units (walkGrid.footprintSoftFreeAt; moving traffic is passed through), touching allowed — the same the
    // planner (localPath) routes by, so the step just EXECUTES toward the planned aim: the aimed step if it's clear, else
    // the best slide (stepToward).  No slip through parked units, no centre-only corner-cut: exact contact plus a
    // slide along the touching face threads a razor between two parked units and a diagonal wall pinch alike (W6).
	freeUnit(world, eid);
	const [nx, ny] = stepToward(world, eid, self, x, y, sx, sy, aimX, aimY, yieldsTo(world, eid));
	// Stood still only for a teammate ahead (it could have moved, passing through it): waiting its turn, not stuck.
	const waiting = nx === x && ny === y && (([px, py]) => px !== x || py !== y)(stepToward(world, eid, self, x, y, sx, sy, aimX, aimY));

	Position.x[eid] = nx; Position.y[eid] = ny;
	reserveUnit(world, eid);

	UnitAnim.moving[eid] = (nx !== x || ny !== y) ? 1 : 0;
	if (nx !== x || ny !== y) { UnitAnim.dir[eid] = octant(nx - x, ny - y); }

    // Progress bookkeeping.  Only beating the best so far resets the stall counter — closer in a straight line to the
    // slot (by PROGRESS_EPS), or a lower cost to go along the route (so going round terrain counts); sliding without
    // gaining, waiting, shuffling through traffic or phasing in place do NOT.  So a group funnelled onto a blocked
    // chokepoint keeps climbing and SETTLES (then spreads via settleOnto) instead of piling there forever.  The same
    // counter gates the give-up settle (STUCK_LIMIT).
	const newDist = distance(goalX - nx, goalY - ny);
	const ff = getOrComputeFlowField(world, Unit.team[eid], goalTx, goalTy);
	const newCost = ff ? ff.cost[clampTile(fpToTile(ny), mapH) * mapW + clampTile(fpToTile(nx), mapW)] : INF;
	const wasCost = ff ? ff.cost[Path.curTy[eid] * mapW + Path.curTx[eid]] : INF;   // its tile at the tick's start, by this field

	// The field changed under it since last tick (its team's exploring re-priced the route): shift the best by as much,
	// so progress is measured on the field it's following, not one that's gone.
	if (wasCost !== INF && Path.lastCost[eid] !== INF && Path.bestCost[eid] !== INF) {
		Path.bestCost[eid] += wasCost - Path.lastCost[eid];
	}

	Path.lastCost[eid] = newCost;
	const closer = newDist <= Path.bestDist[eid] - PROGRESS_EPS;

	if (closer || newCost < Path.bestCost[eid]) {
		if (closer) { Path.bestDist[eid] = newDist; }
		if (newCost < Path.bestCost[eid]) { Path.bestCost[eid] = newCost; }
		Path.stuckTicks[eid] = 0;
	} else if (prevDist <= NEAR_GOAL_FP && footprintSoftFreeAt(world, goalX, goalY, self, eid)) {
        // Near the goal but couldn't thread the last bit in — rest at the goal POSITION if it's clear.
		settleOnto(world, eid, self, goalX, goalY);
	} else if (!waiting) {
		noProgress(world, eid, self);
	}
}

// ── Pre-map fallback (dev only) ────────────────────────────────────────────────
function movePreMap(world: SimWorld): void {
	const { MoveTarget, Position, UnitAnim } = world.components;

	for (const eid of unitEids(world)) {
		if (!MoveTarget.active[eid]) { continue; }
		let sx = MoveTarget.tx[eid] - Position.x[eid];
		let sy = MoveTarget.ty[eid] - Position.y[eid];
		const d = distance(sx, sy);

		if (d <= UNIT_SPD) {
			Position.x[eid] = MoveTarget.tx[eid];
			Position.y[eid] = MoveTarget.ty[eid];
			stopUnit(world, eid);
			continue;
		}

		sx = (sx * UNIT_SPD / d) | 0;
		sy = (sy * UNIT_SPD / d) | 0;
		Position.x[eid] += sx;
		Position.y[eid] += sy;
		UnitAnim.dir[eid] = octant(sx, sy);
		UnitAnim.moving[eid] = 1;
	}
}
