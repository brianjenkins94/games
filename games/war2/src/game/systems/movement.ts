/**
 * Movement system — tile-by-tile flow-field following.
 *
 * Each tick per active unit:
 *   1. Interpolate toward the current MoveTarget (next tile centre).
 *   2. On arrival: read the flow field for the unit's goal tile to get the
 *      next direction, check occupancy, and step forward.
 *
 * Local steering: if the preferred tile is occupied, try ±45°, ±90° offsets
 * from the flow direction before giving up for this tick.  This handles
 * formation spreading without global replan.
 *
 * If no adjacent tile is free the unit waits one tick and retries — MoveTarget
 * stays at the current tile centre so the interpolation sees dist≈0 and
 * re-enters the arrival branch immediately.
 */

import { query } from "bitecs";
import { Position, MoveTarget, Unit, Path, UnitAnim, UNIT_SPD, tileCenterFP } from "../components";
import { freeTile, occupyTile, isEmpty } from "../occupancy";
import { getOrComputeFlowField, DIR_DX, DIR_DY, UNREACHABLE } from "../flowField";
import { getPassability, getMapW, getMapH } from "../passability";
import { distance } from "../distance";

/** Halt a unit: clear all movement and animation state in one place.
 *  Occupancy is intentionally left untouched — the unit stops on its current tile. */
export function stopUnit(eid: number): void {
    MoveTarget.active[eid] = 0;
    Path.active[eid]       = 0;
    UnitAnim.moving[eid]   = 0;
}

// Steering: clockwise offsets tried after the preferred direction fails.
// ±45°, ±90° — gives natural spreading without recomputing the flow field.
const STEER = [1, 7, 2, 6, 3, 5] as const;

export function movementSystem(world: object): void {
    const pass = getPassability();
    const mapW = getMapW();
    const mapH = getMapH();

    for (const eid of query(world, [Position, MoveTarget, Unit])) {
        if (!MoveTarget.active[eid]) continue;

        const dx    = MoveTarget.tx[eid] - Position.x[eid];
        const dy    = MoveTarget.ty[eid] - Position.y[eid];
        const dist2 = dx * dx + dy * dy;

        if (dist2 > UNIT_SPD * UNIT_SPD) {
            // Still travelling — interpolate.  Magnitude via the integer metric
            // (no sqrt): keeps the whole sim path float-free and deterministic.
            const dist = distance(dx, dy);
            Position.x[eid] += (dx * UNIT_SPD / dist) | 0;
            Position.y[eid] += (dy * UNIT_SPD / dist) | 0;
            continue;
        }

        // ── Arrived at tile centre ────────────────────────────────────────────
        Position.x[eid] = MoveTarget.tx[eid];
        Position.y[eid] = MoveTarget.ty[eid];

        if (!Path.active[eid]) {
            MoveTarget.active[eid] = 0;
            UnitAnim.moving[eid]   = 0;
            continue;
        }

        const cx = Path.curTx[eid];
        const cy = Path.curTy[eid];

        // Reached goal?
        if (cx === Path.goalTx[eid] && cy === Path.goalTy[eid]) {
            stopUnit(eid); continue;
        }

        // Adjacent to an occupied goal → settle here.
        // When units share a goal the first arrival parks on it; every other
        // unit that is already next to it will never be able to step onto it,
        // so orbiting/ring-around-the-rosy would occur without this check.
        const goalTx = Path.goalTx[eid];
        const goalTy = Path.goalTy[eid];
        if (Math.abs(cx - goalTx) <= 1 && Math.abs(cy - goalTy) <= 1 && !isEmpty(goalTx, goalTy)) {
            stopUnit(eid); continue;
        }

        // Read flow direction for current tile
        const ff = getOrComputeFlowField(Path.goalTx[eid], Path.goalTy[eid]);
        if (!ff) { stopUnit(eid); continue; }

        const flowDir = ff.dirs[cy * mapW + cx];
        if (flowDir === UNREACHABLE) { stopUnit(eid); continue; }

        // Try preferred direction, then steer alternatives
        let stepped = false;
        const dirsToTry = [flowDir, ...STEER.map(o => (flowDir + o) & 7)];

        for (const dir of dirsToTry) {
            const nx = cx + DIR_DX[dir];
            const ny = cy + DIR_DY[dir];
            if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) continue;
            if (pass && pass[ny * mapW + nx]) continue;                  // terrain blocked
            if (DIR_DX[dir] !== 0 && DIR_DY[dir] !== 0) {               // diagonal: check corners
                if (pass && (pass[cy * mapW + nx] || pass[ny * mapW + cx])) continue;
            }
            if (!isEmpty(nx, ny)) continue;                              // occupied

            // Step into the new tile
            freeTile(cx, cy);
            occupyTile(nx, ny, eid);
            Path.curTx[eid]      = nx;
            Path.curTy[eid]      = ny;
            MoveTarget.tx[eid]   = tileCenterFP(nx);
            MoveTarget.ty[eid]   = tileCenterFP(ny);
            UnitAnim.dir[eid]    = dir;
            UnitAnim.moving[eid] = 1;
            stepped = true;
            break;
        }

        if (!stepped) {
            // Fully blocked — stay at current centre and retry next tick
            MoveTarget.tx[eid]   = tileCenterFP(cx);
            MoveTarget.ty[eid]   = tileCenterFP(cy);
            UnitAnim.moving[eid] = 0;
        }
        // MoveTarget.active stays 1 in both cases
    }
}
