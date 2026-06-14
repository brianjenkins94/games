/**
 * Movement system — continuous movement on an 8px reservation grid (SC "walk tile" style).
 *
 * Units keep smooth fixed-point positions and steer along the per-team flow field, but
 * collision is resolved by *reservation*: each unit only moves into walk cells that are
 * free (see walkGrid.ts).  A blocked unit slides along the obstacle (axis separation) or
 * waits — it can never overlap another unit, terrain, or a building, and no soft-body
 * shuffle is needed.  Reservation is persistent: units hold their footprint between ticks
 * (claimed on spawn / snapshot restore), so idle and display-only units are obstacles the
 * movers route around for free.
 *
 * Determinism: integer fixed-point throughout; magnitudes via the sqrt-free dodecagon
 * distance().  Reservation is order-dependent but the referee processes units in a stable
 * eid order that snapshot/replay reproduces.  UnitAnim is render-only (excluded from hash).
 */

import { query } from "bitecs";
import {
    Position, MoveTarget, Unit, Path, UnitAnim, Building,
    UNIT_SPD, FP, fpToTile, tileCenterFP,
} from "../components";
import { footprintFreeAt, freeUnit, reserveUnit } from "../walkGrid";
import { getOrComputeFlowField, DIR_DX, DIR_DY, UNREACHABLE } from "../flowField";
import { getMapW, getMapH } from "../passability";
import { unitBoxHalfPx } from "../unitTypes";
import { distance } from "../distance";

// ── Tunables ──────────────────────────────────────────────────────────────────
const ARRIVE_FP    = 4 * FP;        // within this of the goal point → settle
const PROGRESS_EPS = UNIT_SPD >> 1; // min progress/tick toward goal to stay "moving"
const STUCK_LIMIT  = 12;            // ticks of ~no progress before a blocked unit settles

const clampTile = (t: number, n: number) => (t < 0 ? 0 : t >= n ? n - 1 : t);

/** Halt a unit: clear movement, path and animation state in one place.
 *  The unit keeps its current walk-cell reservation (it just stops on it). */
export function stopUnit(eid: number): void {
    MoveTarget.active[eid] = 0;
    Path.active[eid]       = 0;
    Path.stuckTicks[eid]   = 0;
    UnitAnim.moving[eid]   = 0;
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

/** Steer one active unit one step and resolve collision by reservation. */
function stepUnit(eid: number, mapW: number, mapH: number): void {
    const x = Position.x[eid], y = Position.y[eid];
    const goalX = MoveTarget.tx[eid], goalY = MoveTarget.ty[eid];

    const prevDist = distance(goalX - x, goalY - y);
    if (prevDist <= ARRIVE_FP) { stopUnit(eid); return; }

    // Aim point: straight at the goal once in the goal tile, else the centre of the
    // next tile the flow field points to.
    const curTx = fpToTile(x), curTy = fpToTile(y);
    const goalTx = Path.goalTx[eid], goalTy = Path.goalTy[eid];
    let aimX = goalX, aimY = goalY;
    if (!(curTx === goalTx && curTy === goalTy)) {
        const ff = getOrComputeFlowField(Unit.team[eid], goalTx, goalTy);
        if (!ff) { stopUnit(eid); return; }
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

    // Reservation move: free self, then take the largest sub-move whose cells are free
    // (full, else slide along X or Y), then re-reserve.
    const [hwPx, hhPx] = unitBoxHalfPx(Unit.type[eid]);
    const hw = hwPx * FP, hh = hhPx * FP;
    freeUnit(eid);
    let nx = x, ny = y;
    if (footprintFreeAt(x + sx, y + sy, hw, hh, eid)) {
        nx = x + sx; ny = y + sy;
    } else if (sx !== 0 && footprintFreeAt(x + sx, y, hw, hh, eid)) {
        nx = x + sx;
    } else if (sy !== 0 && footprintFreeAt(x, y + sy, hw, hh, eid)) {
        ny = y + sy;
    }
    Position.x[eid] = nx; Position.y[eid] = ny;
    reserveUnit(eid);

    if (nx !== x || ny !== y) {
        UnitAnim.dir[eid]    = dirFromDelta(nx - x, ny - y);
        UnitAnim.moving[eid] = 1;
    } else {
        UnitAnim.moving[eid] = 0;   // blocked this tick (waiting on traffic / walled in)
    }

    // Arrival / stuck bookkeeping.
    const newDist = distance(goalX - nx, goalY - ny);
    if (newDist <= ARRIVE_FP) { stopUnit(eid); return; }
    if (prevDist - newDist >= PROGRESS_EPS) {
        Path.stuckTicks[eid] = 0;                 // still making headway
    } else if (++Path.stuckTicks[eid] >= STUCK_LIMIT) {
        stopUnit(eid);   // no headway for a while (jammed / crowded goal) → settle here
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
