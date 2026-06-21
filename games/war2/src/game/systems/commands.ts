import { spawnUnit, spawnBuilding, canPlaceBuilding, eidForUnitId, type SimWorld } from "../world";
import { setMoveTarget, setFormationTargets, setGatherTargets, stopUnit } from "../orders";
import { Position, Unit, FP, TILE_PX, fpToTile } from "../components";
import { distance } from "../distance";
import { CmdType, type Command } from "../../net/protocol";

// A cohesive multi-unit MOVE keeps its formation (each unit holds its offset from the group
// centroid).  A scattered selection, or re-clicking the same spot, gathers into a compact block.
const FORMATION_SPREAD_MAX = 8 * TILE_PX * FP;   // max unit-to-centroid distance to still hold formation

/**
 * Apply a MOVE.  One unit → straight to the point.  A cohesive group → FORMATION: each unit keeps
 * its offset from the centroid (an axis-aligned translation), so the selection arrives in the same
 * arrangement.  A too-scattered selection, or re-clicking the *same* tile with the *same* selection,
 * → CONVERGE: setGatherTargets packs them into a compact grid-aligned block instead.
 */
function applyMove(world: SimWorld, eids: number[], txFP: number, tyFP: number): void {
    const team   = Unit.team[eids[0]];
    const tileX  = fpToTile(txFP), tileY = fpToTile(tyFP);
    // Order-independent signature of the selection, to detect a repeat click by the same group.
    let sig = eids.length;
    for (const e of [...eids].sort((a, b) => a - b)) sig = (Math.imul(sig, 31) + e) | 0;
    const memo   = (world.lastMove ??= {});
    const prev   = memo[team];
    const repeat = prev !== undefined && prev.tileX === tileX && prev.tileY === tileY && prev.sig === sig;
    memo[team]   = { tileX, tileY, sig };

    const dropGather = () => { if (world.gatherSlots) delete world.gatherSlots[team]; };

    if (eids.length === 1) { dropGather(); setMoveTarget(world, eids[0], txFP, tyFP, true, true); return; }

    let sx = 0, sy = 0;
    for (const e of eids) { sx += Position.x[e]; sy += Position.y[e]; }
    const cx = (sx / eids.length) | 0;
    const cy = (sy / eids.length) | 0;

    let maxD = 0;
    for (const e of eids) {
        const d = distance(Position.x[e] - cx, Position.y[e] - cy);
        if (d > maxD) maxD = d;
    }

    // Repeat click, or too scattered to hold a sensible formation → converge into a block.
    if (repeat || maxD > FORMATION_SPREAD_MAX) { setGatherTargets(world, eids, txFP, tyFP); return; }

    dropGather();
    // Hold formation (centroid-offset translation); slots on impassable terrain reflow onto nearby
    // passable ground rather than collapsing onto the click point — see setFormationTargets.
    setFormationTargets(world, eids, txFP, tyFP);
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
