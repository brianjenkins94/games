/**
 * Movement system — "WC2 atop SC": an SC-style avoidance base with a WC2-style tile layer for rest.
 *
 *   • Avoidance base (while moving): a unit steers toward an aim chosen by the pathing (long-range
 *     terrain flow field + short-range unit-aware local A*), reserving its walk cells so others see
 *     it.  Sub-tile move per tick, via a fallback ladder (see stepUnit):
 *       – full step: terrain + all units clear.  Unit↔unit collision is a DIAMOND, so its slim
 *         diagonals let a unit thread the gap between two diagonally-placed units RIGHT HERE — no
 *         special "squeeze" is needed for that (the diamond geometry does it).
 *       – SLIP (diagonal, unit-collision OFF; terrain still blocks): flow through MOVING traffic and
 *         razor (exactly-touching, L1=32) cells the planner uses but a solid step can't traverse.
 *       – cardinal slide / lane-centre: ride the tile-lane centre so a full-tile unit fits a 1-tile
 *         cardinal gap (off-centre, the perpendicular nudge truncates to 0 and the unit stalls).
 *       – corner-cut (diagonal, terrain checked CENTRE-only): thread a diagonal terrain pinch /
 *         stairstep, grazing the flanking wall corners (centre stays in open terrain — no tunnelling).
 *       – follow movers / after GHOST_AFTER ticks, phase through as a last resort.
 *     CARDINAL steps otherwise stay solid (full unit collision → one-per-lane).
 *
 *   • Tile layer (at rest): when a unit arrives (or is walled past STUCK_LIMIT and can't even phase)
 *     it snaps onto the nearest tile centre free of other units and reserves it (see settleOnto).
 *     Because each unit is handed a distinct tile target (formation offset / gather slot — see
 *     world.ts), the group comes to rest one-per-tile: grid-crisp and never stacked.
 *
 * `stuckTicks` drives the escalation and is keyed on *goal progress*: a clean (tier-1) move or any
 * real gain toward the goal resets it; merely waiting, shuffling sideways through a pile of traffic,
 * or phasing in place does not — so it climbs to GHOST_AFTER (start phasing) and on to STUCK_LIMIT
 * (settle).  Keying on progress (not just "did I move") is what makes a group funnelled onto a
 * blocked chokepoint settle and spread instead of piling onto one tile forever.  This replaced an
 * earlier hard-reservation model whose every-tick no-overlap rule needed a pile of special cases
 * (slide/slip/wait, far-first, loiter, settle guards).
 *
 * Determinism: integer fixed-point throughout; magnitudes via the sqrt-free dodecagon distance().
 * Reservation is order-dependent but the referee processes units in a stable eid order that
 * snapshot/replay reproduces.  UnitAnim is render-only (excluded from hash).
 */

import { query } from "bitecs";
import {
    Position, MoveTarget, Unit, Path, UnitAnim, Building,
    UNIT_SPD, FP, TILE_PX, fpToTile, tileCenterFP, snapWalkFP,
} from "../components";
import { footprintFreeAt, footprintSoftFreeAt, footprintStaticFreeAt, terrainCentreClearAt, unitsSoftFreeAt, separateFrom, freeUnit, reserveUnit } from "../walkGrid";
import { markIdleDirty } from "../pathObstacles";
import { localNextAim, LOCAL_RANGE } from "../localPath";
import { getBelievedPassability } from "../vision";
import { getOrComputeFlowField, DIR_DX, DIR_DY, UNREACHABLE } from "../flowField";
import { getMapW, getMapH } from "../passability";
import { unitRadiusPx } from "../unitTypes";
import { distance } from "../distance";

// ── Tunables ──────────────────────────────────────────────────────────────────
const ARRIVE_FP    = 2 * FP;          // within this of the goal point → settle.  Small, because the
                                      // collision-off final approach walks the unit ~exactly onto the
                                      // centre, so settle's snap is a ≤2px no-op (no visible grid-pop).
const PROGRESS_EPS = UNIT_SPD >> 1;   // min gain/tick toward the goal to count as "progress"
const GHOST_AFTER  = 5;               // ticks boxed in before phasing through units.  Short now that the
                                      // local A* does the routing-around: phasing is only reached when a
                                      // unit is genuinely boxed (no way around), so a long wait on
                                      // stationary blockers that will never move is just dead time.
const STUCK_LIMIT  = 36;              // ticks fully walled (can't even phase) before settling nearby
const SETTLE_R     = 5;               // tiles: how far to look for a free rest tile when settling
const NEAR_GOAL_FP = 48 * FP;         // ≤1.5 tiles from goal + blocked → snap onto the (free) goal tile
const JAM_FP       = 8 * FP;          // de-penetration only fires when overlapping by MORE than this
                                      // (deep jam), so a shallow touch isn't bounced.

const clampTile = (t: number, n: number) => (t < 0 ? 0 : t >= n ? n - 1 : t);

/** Move `delta` capped to a per-axis `budget` (≥0), exact when within it — no normalise/truncate, so a
 *  sub-pixel lane correction never rounds away to zero (which would asymptote a unit at a 1-tile gap). */
const clampStep = (delta: number, budget: number): number =>
    budget <= 0 ? 0 : delta > budget ? budget : delta < -budget ? -budget : delta;

/** Halt a unit: clear movement, path and animation state in one place.
 *  The unit keeps its current walk-cell reservation (it just stops on it). */
export function stopUnit(eid: number): void {
    MoveTarget.active[eid] = 0;
    Path.active[eid]       = 0;
    Path.stuckTicks[eid]   = 0;
    UnitAnim.moving[eid]   = 0;
    markIdleDirty();   // a settled unit joins the path-obstacle set (flow fields route around it)
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
function settleOnto(eid: number, rad: number, restX = Position.x[eid], restY = Position.y[eid]): void {
    freeUnit(eid);
    const bx = snapWalkFP(restX), by = snapWalkFP(restY);   // 8px-aligned rest base
    const STEP = TILE_PX * FP;
    for (let ring = 0; ring <= SETTLE_R; ring++) {
        for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const fx = bx + dx * STEP, fy = by + dy * STEP;
            if (footprintSoftFreeAt(fx, fy, rad, eid)) {
                Position.x[eid] = fx; Position.y[eid] = fy;
                reserveUnit(eid); stopUnit(eid);
                return;
            }
        }
    }
    reserveUnit(eid); stopUnit(eid);   // nothing free nearby → rest where we are (last resort)
}

/** 8-way facing (0=N..7=NW) from a movement delta — render-only (cosmetic; never hashed). */
function dirFromDelta(dx: number, dy: number): number {
    const a = (Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
    return Math.round(a / (Math.PI / 4)) & 7;
}

export function movementSystem(world: object): void {
    const mapW = getMapW();
    const mapH = getMapH();

    // Pre-map dev mode (no terrain / no walk grid): direct movement, no collision.
    if (mapW === 0) { movePreMap(world); return; }

    for (const eid of query(world, [Position, MoveTarget, Unit])) {
        if (Building.fw[eid] > 0) continue;                 // buildings: static, never move

        if (Unit.movable[eid] === 1 && MoveTarget.active[eid] === 1) {
            stepUnit(eid, mapW, mapH);
        }
        // Refresh the tile the unit sits in (drives flow-field & vision sampling).
        Path.curTx[eid] = clampTile(fpToTile(Position.x[eid]), mapW);
        Path.curTy[eid] = clampTile(fpToTile(Position.y[eid]), mapH);
    }
}

/** Steer one active unit one step: prefer a clean move that avoids units + terrain (route around);
 *  if boxed in, wait, then phase through units as a last resort; settle onto a free tile on arrival
 *  or when terrain-walled too long.  See the module header for the stuckTicks escalation. */
function stepUnit(eid: number, mapW: number, mapH: number): void {
    const x = Position.x[eid], y = Position.y[eid];
    const goalX = MoveTarget.tx[eid], goalY = MoveTarget.ty[eid];
    const r = unitRadiusPx(Unit.type[eid]) * FP;   // diamond collision radius (sub-tile)

    // De-penetrate first: if we're DEEPLY overlapping a settled unit (we settled-onto / were settled-
    // onto), push back OUT along the separation normal and spend the tick on that — a unit must never
    // stay jammed inside a parked one.  Uses r-JAM_FP, so the shallow touch of a 45° slip (below) isn't
    // treated as a jam and bounced back out.
    const sep = separateFrom(x, y, r - JAM_FP, eid);
    if (sep[0] !== 0 || sep[1] !== 0) {
        freeUnit(eid);
        Position.x[eid] = x + sep[0]; Position.y[eid] = y + sep[1];
        reserveUnit(eid);
        UnitAnim.moving[eid] = 1;
        UnitAnim.dir[eid] = dirFromDelta(sep[0], sep[1]);
        Path.stuckTicks[eid] = 0;
        return;
    }

    const prevDist = distance(goalX - x, goalY - y);
    if (prevDist <= ARRIVE_FP) { settleOnto(eid, r); return; }   // arrived → rest on a free tile

    // Aim point.  Two-tier pathing all the way to the goal TILE: within LOCAL_RANGE a bounded, SUB-TILE
    // (8px) unit-aware A* routes the unit's centre around settled units' real C-space footprints
    // (localPath.ts) — so it goes AROUND a unit anchored off-centre that pokes into its lane, not into
    // it; farther out the cached terrain-only flow field gives the direction.  Only once the unit is
    // standing IN the goal tile does it beeline the exact (sub-tile, 8px-anchored) goal point.
    const curTx = fpToTile(x), curTy = fpToTile(y);
    // Path.goalTx/goalTy is the SHARED flow-field goal (group destination — one cached field for the whole
    // group); slotTx/slotTy is THIS unit's own final slot, derived from its MoveTarget point.  The unit
    // rides the shared field toward the destination, then the local layer (within LOCAL_RANGE of the slot)
    // peels it onto its own slot — travel-as-a-block, reorganise-into-formation-on-arrival.
    const goalTx = Path.goalTx[eid], goalTy = Path.goalTy[eid];
    const slotTx = fpToTile(goalX), slotTy = fpToTile(goalY);
    let aimX = goalX, aimY = goalY;
    let laneAxis = 0;     // flow steering a CARDINAL move: 1 = vertical (centre on X lane), 2 = horizontal (Y)
    let corridor = false; // driving along a committed pinch corridor (recentre onto the line, then thread)
    if (!(curTx === slotTx && curTy === slotTy)) {
        // (1) Committed to a pinch corridor → drive to its exit-tile CENTRE; don't re-sample the flow (so
        //     the tile-boundary direction flip and the 4-corner sampling singularity can't wedge it).
        if (Path.wpActive[eid] === 1) {
            const wcx = tileCenterFP(Path.wpTx[eid]), wcy = tileCenterFP(Path.wpTy[eid]);
            if (distance(wcx - x, wcy - y) <= ARRIVE_FP) Path.wpActive[eid] = 0;   // arrived → resume
            else { aimX = wcx; aimY = wcy; corridor = true; }
        }
        if (Path.wpActive[eid] === 0) {
            const near = Math.abs(curTx - slotTx) <= LOCAL_RANGE && Math.abs(curTy - slotTy) <= LOCAL_RANGE;
            const localAim = near ? localNextAim(Unit.team[eid], x, y, goalX, goalY, r) : null;
            if (localAim) {
                aimX = localAim[0]; aimY = localAim[1];
            } else {
                const ff = getOrComputeFlowField(Unit.team[eid], goalTx, goalTy);
                if (!ff) { settleOnto(eid, r); return; }
                const flowDir = ff.dirs[curTy * mapW + curTx];
                if (flowDir !== UNREACHABLE) {
                    const dxd = DIR_DX[flowDir], dyd = DIR_DY[flowDir];
                    const pass = getBelievedPassability(Unit.team[eid]);
                    const pinch = dxd !== 0 && dyd !== 0 && !!pass &&
                        pass[curTy * mapW + (curTx + dxd)] === 1 && pass[(curTy + dyd) * mapW + curTx] === 1;
                    if (pinch) {                                   // commit to threading the pinch corridor
                        Path.wpActive[eid] = 1;
                        Path.wpFromTx[eid] = curTx; Path.wpFromTy[eid] = curTy;
                        Path.wpTx[eid] = curTx + dxd; Path.wpTy[eid] = curTy + dyd;
                        aimX = tileCenterFP(curTx + dxd); aimY = tileCenterFP(curTy + dyd); corridor = true;
                    } else {
                        aimX = tileCenterFP(curTx + dxd); aimY = tileCenterFP(curTy + dyd);
                        if (dxd === 0) laneAxis = 1;        // moving N/S → ride the X lane centre
                        else if (dyd === 0) laneAxis = 2;   // moving E/W → ride the Y lane centre
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
        const fcx = tileCenterFP(Path.wpFromTx[eid]), fcy = tileCenterFP(Path.wpFromTy[eid]);
        const ldx = aimX >= fcx ? 1 : -1, ldy = aimY >= fcy ? 1 : -1;          // corridor direction (±1,±1)
        const perp = (x - fcx) * ldy - (y - fcy) * ldx;                         // 0 ⇔ on the line
        if (perp !== 0) {
            // Project onto the corridor SEGMENT (not the infinite line): clamp so the recentre target
            // stays between source and exit centres — never behind the source (which can be off-map).
            const lenA = (((aimX - fcx) * ldx + (aimY - fcy) * ldy) / 2) | 0;   // dest's along-scalar (≥0)
            let along = (((x - fcx) * ldx + (y - fcy) * ldy) / 2) | 0;
            along = along < 0 ? 0 : along > lenA ? lenA : along;
            const projX = fcx + along * ldx, projY = fcy + along * ldy;         // nearest point on the segment
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

    // Move ladder (free self first so it isn't its own obstacle).  The sub-tile A* (localPath) already
    // routed the AIM around settled units' C-space, so the reactive layer just EXECUTES toward that aim:
    //  • full step (terrain + all units clear) — the common case on a planned path; the DIAMOND footprint
    //    threads the gap between two diagonally-placed units right here (no special tier for that).
    //  • SLIP toward the aim with unit-collision OFF (terrain still blocks).  Because the planner routed
    //    the aim around units, this only ignores collision at a razor (a "touching" L1=32 cell the planner
    //    legitimately uses but continuous movement can't traverse without dipping under 32) or to flow
    //    through MOVING traffic — never straight through a unit the planner avoided.
    //  • cardinal slide X / Y — round a TERRAIN corner (when the aim direction is terrain-blocked).
    //  • diagonal CORNER-CUT (terrain checked centre-only) — thread a diagonal terrain pinch / stairstep,
    //    grazing the flanking wall corners; settled units still block.
    //  • follow movers / phase — convoy flow fallbacks.
    // When a diagonal is terrain-blocked the unit slides along the free axis — at FULL speed toward the
    // aim on that axis, not just the diagonal's component (which wastes the blocked axis's budget and
    // visibly slows a unit threading a gap).  Capped so it can't overshoot the aim.
    const fullX = clampStep(aimX - x, UNIT_SPD);
    const fullY = clampStep(aimY - y, UNIT_SPD);

    freeUnit(eid);
    const canPhase = Path.stuckTicks[eid] >= GHOST_AFTER;
    let nx = x, ny = y, tier1 = false;
    if (footprintFreeAt(x + sx, y + sy, r, eid)) {
        nx = x + sx; ny = y + sy; tier1 = true;
    } else if (footprintStaticFreeAt(x + sx, y + sy, r)) {
        nx = x + sx; ny = y + sy; tier1 = true;                     // SLIP toward the (planner-routed) aim
    } else if (fullX !== 0 && footprintFreeAt(x + fullX, y, r, eid)) {
        nx = x + fullX; tier1 = true;                               // slide X around terrain (full speed)
    } else if (fullY !== 0 && footprintFreeAt(x, y + fullY, r, eid)) {
        ny = y + fullY; tier1 = true;                               // slide Y (full speed)
    } else if (sx !== 0 && sy !== 0 && terrainCentreClearAt(x + sx, y + sy) && unitsSoftFreeAt(x + sx, y + sy, r, eid)) {
        nx = x + sx; ny = y + sy; tier1 = true;                     // diagonal CORNER-CUT: thread a wall
        // pinch / stairstep.  Terrain is checked centre-only (any box clips the flanking walls at the
        // exact corner), so the centre stays in open terrain while the footprint grazes the corners;
        // settled units still block (unitsSoftFreeAt) so it never cuts straight through a parked unit.
    } else if (sx !== 0 && footprintSoftFreeAt(x + sx, y, r, eid)) {
        nx = x + sx;                                                 // follow moving traffic (cardinal)
    } else if (sy !== 0 && footprintSoftFreeAt(x, y + sy, r, eid)) {
        ny = y + sy;
    } else if (canPhase) {
        // Waited long enough → push through MOVING traffic on either axis (full diagonal too).  Settled
        // units + terrain still block (footprintSoftFreeAt), so we never phase INTO a parked unit and
        // jam inside it — being boxed by parked units instead waits and settles (STUCK_LIMIT).
        if (footprintSoftFreeAt(x + sx, y + sy, r, eid)) { nx = x + sx; ny = y + sy; }
        else if (sx !== 0 && footprintSoftFreeAt(x + sx, y, r, eid)) { nx = x + sx; }
        else if (sy !== 0 && footprintSoftFreeAt(x, y + sy, r, eid)) { ny = y + sy; }
    }
    Position.x[eid] = nx; Position.y[eid] = ny;
    reserveUnit(eid);

    UnitAnim.moving[eid] = (nx !== x || ny !== y) ? 1 : 0;
    if (nx !== x || ny !== y) UnitAnim.dir[eid] = dirFromDelta(nx - x, ny - y);

    // Progress bookkeeping.  A clean (tier-1) move — which includes sliding sideways to round an
    // obstacle — or any real gain toward the goal resets the stall counter; waiting, shuffling
    // sideways through traffic, or phasing in place do NOT.  So a group funnelled onto a blocked
    // chokepoint keeps climbing and SETTLES (then spreads via settleOnto) instead of piling there
    // forever.  The same counter gates phasing (GHOST_AFTER) and the give-up settle (STUCK_LIMIT).
    const newDist = distance(goalX - nx, goalY - ny);
    if (tier1 || prevDist - newDist >= PROGRESS_EPS) {
        Path.stuckTicks[eid] = 0;
    } else if (prevDist <= NEAR_GOAL_FP && footprintSoftFreeAt(goalX, goalY, r, eid)) {
        // Near the goal but couldn't thread the last bit in — rest at the goal POSITION if it's clear.
        settleOnto(eid, r, goalX, goalY);
    } else if (++Path.stuckTicks[eid] >= STUCK_LIMIT) {
        settleOnto(eid, r);
    }
}

// ── Pre-map fallback (dev only) ────────────────────────────────────────────────
function movePreMap(world: object): void {
    for (const eid of query(world, [Position, MoveTarget, Unit])) {
        if (!MoveTarget.active[eid]) continue;
        let sx = MoveTarget.tx[eid] - Position.x[eid];
        let sy = MoveTarget.ty[eid] - Position.y[eid];
        const d = distance(sx, sy);
        if (d <= UNIT_SPD) {
            Position.x[eid] = MoveTarget.tx[eid];
            Position.y[eid] = MoveTarget.ty[eid];
            stopUnit(eid);
            continue;
        }
        sx = (sx * UNIT_SPD / d) | 0;
        sy = (sy * UNIT_SPD / d) | 0;
        Position.x[eid] += sx;
        Position.y[eid] += sy;
        UnitAnim.dir[eid]    = dirFromDelta(sx, sy);
        UnitAnim.moving[eid] = 1;
    }
}
