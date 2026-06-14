import { setMoveTarget, stopUnit, spawnUnit, spawnBuilding, canPlaceBuilding, eidForUnitId, type SimWorld } from "../world";
import { CmdType, type Command } from "../../net/protocol";

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
            for (const uid of cmd.unitIds) {
                const eid = eidForUnitId(uid);
                if (eid !== undefined) setMoveTarget(world, eid, cmd.txFP, cmd.tyFP);
            }
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
