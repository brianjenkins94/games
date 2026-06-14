import { setMoveTarget, stopUnit, spawnUnit, spawnBuilding, canPlaceBuilding, eidForUnitId, type SimWorld } from "../world";
import { Position, FP, TILE_PX } from "../components";
import { distance } from "../distance";
import { CmdType, type Command } from "../../net/protocol";

// A multi-unit MOVE keeps its formation only when the group is reasonably cohesive.
// A more scattered selection just gathers on the click point instead (the offsets
// would otherwise scatter units to odd spots far from where the player aimed).
const FORMATION_SPREAD_MAX = 8 * TILE_PX * FP;   // max unit-to-centroid distance for formation

/**
 * Apply a MOVE to one unit or, for a group, in StarCraft-style FORMATION: each unit
 * keeps its offset from the group's centroid, so the selection travels and arrives in
 * the same arrangement instead of all converging on the exact click point (the silly
 * inward-facing huddle).
 *
 * The offsets are an axis-aligned TRANSLATION — the block is NOT rotated to the travel
 * angle (that tilts the shape off the grid on diagonal moves and looks skewed; facing
 * the travel direction is a separate, cosmetic concern handled by the renderer).
 *
 * Deterministic: centroid is an integer mean of the addressed units' positions, so
 * both sims derive identical per-unit goals.  Blocked/off-map slots are snapped to the
 * nearest passable tile by setMoveTarget.
 */
function applyMove(world: SimWorld, eids: number[], txFP: number, tyFP: number): void {
    if (eids.length === 1) { setMoveTarget(world, eids[0], txFP, tyFP); return; }

    let sx = 0, sy = 0;
    for (const e of eids) { sx += Position.x[e]; sy += Position.y[e]; }
    const cx = (sx / eids.length) | 0;
    const cy = (sy / eids.length) | 0;

    let maxD = 0;
    for (const e of eids) {
        const d = distance(Position.x[e] - cx, Position.y[e] - cy);
        if (d > maxD) maxD = d;
    }
    const formation = maxD <= FORMATION_SPREAD_MAX;

    for (const e of eids) {
        if (formation) setMoveTarget(world, e, txFP + (Position.x[e] - cx), tyFP + (Position.y[e] - cy));
        else           setMoveTarget(world, e, txFP, tyFP);
    }
}

/**
 * Apply a batch of commands to the authoritative sim.
 *
 * Commands reference units by stable unitId (not bitecs eid).  SPAWN/BUILD create
 * units; the referee mints their ids here (clients no longer carry one).  Callers
 * should validate ownership/legality first (game/validate.ts); placement is still
 * re-checked here as the deterministic source of truth.
 */
export function applyCommands(world: SimWorld, cmds: Command[]): void {
    for (const cmd of cmds) {
        if (cmd.type === CmdType.MOVE) {
            const eids: number[] = [];
            for (const uid of cmd.unitIds) {
                const eid = eidForUnitId(uid);
                if (eid !== undefined) eids.push(eid);
            }
            if (eids.length > 0) applyMove(world, eids, cmd.txFP, cmd.tyFP);
        } else if (cmd.type === CmdType.SPAWN) {
            spawnUnit(world, cmd.xFP, cmd.yFP, cmd.team, undefined, cmd.typeId);
        } else if (cmd.type === CmdType.STOP) {
            for (const uid of cmd.unitIds) {
                const eid = eidForUnitId(uid);
                if (eid !== undefined) stopUnit(world, eid);
            }
        } else if (cmd.type === CmdType.BUILD) {
            if (canPlaceBuilding(world, cmd.tileX, cmd.tileY, cmd.typeId)) {
                spawnBuilding(world, cmd.tileX, cmd.tileY, cmd.team, cmd.typeId);
            }
        }
    }
}
