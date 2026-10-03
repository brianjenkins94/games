import type { Command } from "./command.ts";
import type { SimWorld } from "./world.ts";
import { CmdType } from "./command.ts";
import { FP, fpToTile, TILE_PX } from "./components.ts";
import { distance } from "./distance.ts";
import { clearOrderQueue, enqueueOrder, setFormationTargets, setGatherTargets, setMoveTarget, stopUnit } from "./orders.ts";
import { buildingTrains, cancelProduction, enqueueProduction, setRally } from "./production.ts";
import { canPlaceBuilding, eidForUnitId, spawnBuilding, spawnUnit } from "./world.ts";

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
	const { Position, Unit, UnitId } = world.components;
	const team = Unit.team[eids[0]];
	const tileX = fpToTile(txFP); const
		tileY = fpToTile(tyFP);
    // Order-independent signature of the selection, to detect a repeat click by the same group — by stable id, so
    // it means the same after a restore (which reallocates eids).
	let sig = eids.length;

	for (const uid of eids.map((e) => UnitId.id[e]).sort((a, b) => a - b)) { sig = (Math.imul(sig, 31) + uid) | 0; }
	world.lastMove ??= {};
	const memo = world.lastMove;
	const prev = memo[team];
	const repeat = prev !== undefined && prev.tileX === tileX && prev.tileY === tileY && prev.sig === sig;

	memo[team] = { "tileX": tileX, "tileY": tileY, "sig": sig };

	const dropGather = () => { if (world.gatherSlots) { delete world.gatherSlots[team]; } };

	if (eids.length === 1) {
		dropGather(); setMoveTarget(world, eids[0], txFP, tyFP, true, true);

		return;
	}

	let sx = 0; let
		sy = 0;

	for (const e of eids) { sx += Position.x[e]; sy += Position.y[e]; }
	const cx = (sx / eids.length) | 0;
	const cy = (sy / eids.length) | 0;

	let maxD = 0;

	for (const e of eids) {
		const d = distance(Position.x[e] - cx, Position.y[e] - cy);

		if (d > maxD) { maxD = d; }
	}

    // Repeat click, or too scattered to hold a sensible formation → converge into a block.
	if (repeat || maxD > FORMATION_SPREAD_MAX) {
		setGatherTargets(world, eids, txFP, tyFP);

		return;
	}

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
 * should validate first (validate.ts: shape, ownership, bounds, type class); placement is still
 * re-checked here as the deterministic source of truth.
 */
export function applyCommands(world: SimWorld, cmds: Command[]): void {
	const { Building, Unit } = world.components;

	for (const cmd of cmds) {
		if (cmd.type === CmdType.MOVE) {
			const eids: number[] = [];

			for (const uid of cmd.unitIds) {
				const eid = eidForUnitId(world, uid);

				if (eid !== undefined) { eids.push(eid); }
			}

			if (eids.length === 0) { continue; }
			if (cmd.queue) {
                // Shift-queue: append a move to each selected unit's action queue (formation logic is
                // for the live, non-queued group move only).
				for (const eid of eids) { enqueueOrder(world, eid, { "kind": "move", "txFP": cmd.txFP, "tyFP": cmd.tyFP }, true); }
			} else {
				for (const eid of eids) { clearOrderQueue(world, eid); }   // replace: drop pending orders
				applyMove(world, eids, cmd.txFP, cmd.tyFP);
			}
		} else if (cmd.type === CmdType.SPAWN) {
			spawnUnit(world, cmd.xFP, cmd.yFP, cmd.team, undefined, cmd.typeId);
		} else if (cmd.type === CmdType.STOP) {
			for (const uid of cmd.unitIds) {
				const eid = eidForUnitId(world, uid);

				if (eid === undefined) { continue; }
				if (cmd.queue) { enqueueOrder(world, eid, { "kind": "stop" }, true); } else { clearOrderQueue(world, eid); stopUnit(world, eid); }
			}
		} else if (cmd.type === CmdType.BUILD) {
			if (canPlaceBuilding(world, cmd.tileX, cmd.tileY, cmd.typeId)) {
				spawnBuilding(world, cmd.tileX, cmd.tileY, cmd.team, cmd.typeId);
			}
		} else if (cmd.type === CmdType.PRODUCE) {
            // Re-check legality at apply-time (deterministic source of truth): building exists, finished,
            // and actually trains the product.
			const beid = eidForUnitId(world, cmd.buildingUid);

			if (beid !== undefined && Building.buildLeft[beid] === 0 && buildingTrains(Unit.type[beid], cmd.productTypeId)) {
				enqueueProduction(world, cmd.buildingUid, cmd.productTypeId);
			}
		} else if (cmd.type === CmdType.CANCEL_PRODUCE) {
			cancelProduction(world, cmd.buildingUid, cmd.index);
		} else if (cmd.type === CmdType.SET_RALLY) {
			if (eidForUnitId(world, cmd.buildingUid) !== undefined) { setRally(world, cmd.buildingUid, cmd.txFP, cmd.tyFP); }
		}
	}
}
