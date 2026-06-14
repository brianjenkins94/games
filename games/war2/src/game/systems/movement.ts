/**
 * Movement system — "WC2 atop SC": a soft SC-style movement base with a WC2-style tile layer
 * for rest.
 *
 *   • Soft base (while moving): a unit steers along the per-team flow field but does NOT reserve
 *     its walk cells — it's a *ghost*.  So moving units flow straight through one another (no
 *     jamming, no formation shear, no stutter); only terrain and *settled* units (which DO reserve)
 *     obstruct it, and it slides along one axis to round them.  Units may overlap freely in transit.
 *
 *   • Tile layer (at rest): when a unit arrives (or is walled too long) it snaps onto the nearest
 *     tile centre that's free of other settled units and reserves it (see settleOnto).  Because each
 *     unit is handed a distinct tile target (formation offset / gather slot — see world.ts), they
 *     come to rest one-per-tile: the resting formation is always grid-crisp and never stacked, even
 *     though they overlapped on the way there.
 *
 * This replaced an earlier hard-reservation model whose every-tick no-overlap rule needed a pile of
 * special cases (slide/slip/wait, far-first slot-claiming, loiter, settle guards) to move smoothly.
 *
 * Determinism: integer fixed-point throughout; magnitudes via the sqrt-free dodecagon distance().
 * Rest reservation is order-dependent but the referee processes units in a stable eid order that
 * snapshot/replay reproduces.  UnitAnim is render-only (excluded from hash).
 */

import { query } from "bitecs";
import {
    Position, MoveTarget, Unit, Path, UnitAnim, Building,
    UNIT_SPD, FP, fpToTile, tileCenterFP,
} from "../components";
import { footprintFreeAt, footprintStaticFreeAt, freeUnit, reserveUnit } from "../walkGrid";
import { getOrComputeFlowField, DIR_DX, DIR_DY, UNREACHABLE } from "../flowField";
import { getMapW, getMapH } from "../passability";
import { unitBoxHalfPx } from "../unitTypes";
import { distance } from "../distance";

// ── Tunables ──────────────────────────────────────────────────────────────────
const ARRIVE_FP    = 4 * FP;          // within this of the goal point → settle
const PROGRESS_EPS = UNIT_SPD >> 1;   // min progress/tick toward goal to stay "moving"
const STUCK_LIMIT  = 30;              // ticks walled (terrain/settled units) before settling nearby
const SETTLE_R     = 5;               // tiles: how far to look for a free rest tile when settling

const clampTile = (t: number, n: number) => (t < 0 ? 0 : t >= n ? n - 1 : t);

/** Halt a unit: clear movement, path and animation state in one place.
 *  The unit keeps its current walk-cell reservation (it just stops on it). */
export function stopUnit(eid: number): void {
    MoveTarget.active[eid] = 0;
    Path.active[eid]       = 0;
    Path.stuckTicks[eid]   = 0;
    UnitAnim.moving[eid]   = 0;
}

/** Settle a unit onto the unit-size grid (the WC2 tile layer on top of the soft SC base).
 *  Snap to the nearest tile centre that's free of other *settled* units, reserve it, and stop.
 *  Moving units don't reserve — they're ghosts that flow through each other — so "free" here means
 *  free of resting units + terrain.  That's the whole trick: units overlap freely in transit, but
 *  each one comes to rest on its own clear tile, so the formation is always grid-crisp and never
 *  stacked.  A unit arrives within ARRIVE_FP of its (distinct) target tile, so r=0 normally hits
 *  that exact tile; the search only widens when its target was already taken (degenerate case). */
function settleOnto(eid: number, hw: number, hh: number): void {
    freeUnit(eid);
    const ctx = fpToTile(Position.x[eid]), cty = fpToTile(Position.y[eid]);
    for (let r = 0; r <= SETTLE_R; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const fx = tileCenterFP(ctx + dx), fy = tileCenterFP(cty + dy);
            if (footprintFreeAt(fx, fy, hw, hh, eid)) {
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

/** Steer one active unit one step.  SC-style soft base: a moving unit is a *ghost* — it doesn't
 *  reserve, so it flows through other moving units (no jamming, no shear, no stutter); only terrain
 *  and *settled* units (which do reserve) block it, and it rounds those on one axis.  On arrival —
 *  or after being walled too long — it settles onto a free tile (the WC2 grid layer, see settleOnto). */
function stepUnit(eid: number, mapW: number, mapH: number): void {
    const x = Position.x[eid], y = Position.y[eid];
    const goalX = MoveTarget.tx[eid], goalY = MoveTarget.ty[eid];
    const [hwPx, hhPx] = unitBoxHalfPx(Unit.type[eid]);
    const hw = hwPx * FP, hh = hhPx * FP;

    const prevDist = distance(goalX - x, goalY - y);
    if (prevDist <= ARRIVE_FP) { settleOnto(eid, hw, hh); return; }   // arrived → rest on a free tile

    // Aim point: straight at the goal once in the goal tile, else the centre of the
    // next tile the flow field points to.
    const curTx = fpToTile(x), curTy = fpToTile(y);
    const goalTx = Path.goalTx[eid], goalTy = Path.goalTy[eid];
    let aimX = goalX, aimY = goalY;
    if (!(curTx === goalTx && curTy === goalTy)) {
        const ff = getOrComputeFlowField(Unit.team[eid], goalTx, goalTy);
        if (!ff) { settleOnto(eid, hw, hh); return; }
        const flowDir = ff.dirs[curTy * mapW + curTx];
        if (flowDir !== UNREACHABLE) {
            aimX = tileCenterFP(curTx + DIR_DX[flowDir]);
            aimY = tileCenterFP(curTy + DIR_DY[flowDir]);
        }
        // UNREACHABLE → aim straight at the goal (best effort).
    }

    // One dist-normalised step toward the aim point (isotropic; clamped to not overshoot).
    let sx = aimX - x, sy = aimY - y;
    const d = distance(sx, sy);
    if (d > UNIT_SPD) {
        sx = (sx * UNIT_SPD / d) | 0;
        sy = (sy * UNIT_SPD / d) | 0;
    }

    // Soft move: free self (a ghost holds no reservation while moving), then take the largest
    // sub-move clear of *terrain* only — units never block each other in motion, so movers flow
    // straight through one another (and diagonally through their own units).  Non-overlap is
    // enforced solely at rest (settleOnto snaps to a free tile).  Slide along X or Y to round
    // terrain.  No re-reserve — the unit stays a ghost until it settles.
    freeUnit(eid);
    let nx = x, ny = y;
    if (footprintStaticFreeAt(x + sx, y + sy, hw, hh)) {
        nx = x + sx; ny = y + sy;
    } else if (sx !== 0 && footprintStaticFreeAt(x + sx, y, hw, hh)) {
        nx = x + sx;
    } else if (sy !== 0 && footprintStaticFreeAt(x, y + sy, hw, hh)) {
        ny = y + sy;
    }
    Position.x[eid] = nx; Position.y[eid] = ny;

    if (nx !== x || ny !== y) {
        UnitAnim.dir[eid]    = dirFromDelta(nx - x, ny - y);
        UnitAnim.moving[eid] = 1;
    } else {
        UnitAnim.moving[eid] = 0;   // blocked this tick (walled by terrain)
    }

    // Walled with ~no progress for too long (only terrain or settled units can wall a ghost) →
    // settle on the nearest free tile rather than grind in place.
    const newDist = distance(goalX - nx, goalY - ny);
    if (prevDist - newDist >= PROGRESS_EPS) Path.stuckTicks[eid] = 0;
    else if (++Path.stuckTicks[eid] >= STUCK_LIMIT) settleOnto(eid, hw, hh);
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
