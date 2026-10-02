/**
 * Snapshot / serialization & received-entity sync — capturing the full sim state and restoring it,
 * plus the lifecycle of entities created from snapshots pushed over the wire (display-only enemies and
 * the guest's predicted own units).  Split out of world.ts.
 *
 * Determinism: applying a snapshot then replaying the command log from that tick forward yields
 * identical state to running the sim continuously — no schema reconciliation.
 */
import type { Order, ProductionState, UnitSnapshot } from "./types.ts";
import type { SimWorld } from "./world.ts";
import { addComponent, addEntity, hasComponent, removeEntity } from "bitecs";
import { clearFlowFieldCache } from "./flowField.ts";
import { fold, hashEntities } from "./hash.ts";
import { freeRect, occupyRect, resetOccupancy } from "./occupancy.ts";
import { markIdleDirty, resetIdleGrids } from "./pathObstacles.ts";
import { rngState } from "./rng.ts";
import { exportExplored, importExplored } from "./vision.ts";
import { freeUnit, reserveUnit, resetWalkGrid } from "./walkGrid.ts";
import { setNextUnitId, unitEids } from "./world.ts";

/**
 * Snapshots of ALL myTeam units.  The sender pushes these every tick; the
 * receiver filters them by their own sight range in applyEnemyStateUpdate so
 * only units genuinely within LOS are spawned.
 *
 * Sending everything is required for bootstrap: neither side starts with any
 * known enemy units, so sender-side "visible to opp" filtering would compute an
 * empty set forever (you can't tell whether the enemy sees your unit without
 * knowing where the enemy is — the very thing fog hides), deadlocking discovery.
 * An honest receiver never displays units it can't see; hiding positions from the
 * wire trustlessly needs a referee (see [[fog-aware-pathfinding-requirement]]).
 */
export function ownSnapshotsVisibleTo(world: SimWorld, myTeam: number): UnitSnapshot[] {
	const { Unit } = world.components;

	return unitEids(world)
		.filter((e) => Unit.team[e] === myTeam)
		.map((e) => snapshotUnit(world, e));
}

/** Snapshot the full state of a single entity. */
export function snapshotUnit(world: SimWorld, eid: number): UnitSnapshot {
    // Footprint only when the entity actually has the Building component — never read the (module-global,
    // possibly recycled) fw/fh array as a proxy for "is a building".
	const { Building, UnitId } = world.components;
	const isBuilding = hasComponent(world, eid, Building);
	const uid = UnitId.id[eid];
    // Queue state (copied, not aliased): production mutates its state object in place each tick.
	const orders = world.orders?.[uid];
	const prod = isBuilding ? world.production?.[uid] : undefined;
	const rally = isBuilding ? world.rally?.[uid] : undefined;

	return {
		"uid": uid,
		"values": world.fields.map(([, column]) => column[eid]),
		...(orders && orders.length ? { "orders": orders.map((o) => ({ ...o })) } : {}),
		...(prod ? { "prod": { "queue": [...prod.queue], "ticksLeft": prod.ticksLeft, "ticksTotal": prod.ticksTotal } } : {}),
		...(rally ? { "rally": { ...rally } } : {})
	};
}

// ── Hash (own-team only) ──────────────────────────────────────────────────────

/** Hash covering only the local team's units — the authoritative portion of the sim. */
export function worldHashOwn(world: SimWorld, myTeam: number): number {
	const { Unit } = world.components;

	return hashEntities(world, unitEids(world).filter((e) => Unit.team[e] === myTeam));
}

// ── Known-enemy lifecycle (receiver side) ────────────────────────────────────
// Enemy units are display-only on the receiving peer: they are not registered
// in the occupancy grid and never call setMoveTarget.  Their positions come
// entirely from STATE_UPDATE snapshots pushed by the owning peer each tick.

function _applyUnitSnapshot(world: SimWorld, eid: number, snap: UnitSnapshot): void {
    // Every sim field (world.fields order). Unit.selected is local UI state — never overwritten from a snapshot.
	for (const [index, [, column]] of world.fields.entries()) {
		column[eid] = snap.values[index];
	}
}

/** Re-lay occupancy for a restored entity.  Only buildings reserve tiles now
 *  (their footprint rect); mobile units collide continuously and reserve nothing.
 *  Buildings also need their Building component (re-)added so the construction
 *  query finds them. */
function _restoreOccupancy(world: SimWorld, eid: number): void {
	const { Building, Path } = world.components;

	if (Building.fw[eid] > 0) {
		addComponent(world, eid, Building);
		occupyRect(world, Path.curTx[eid], Path.curTy[eid], Building.fw[eid], Building.fh[eid], eid);
	} else if (world.walk) {
		reserveUnit(world, eid);   // mobile / display-only unit: claim its 8px footprint
	}
}

// ── Restored-unit lifecycle (from received snapshots) ────────────────────────────
// Two flavours, differing only in `displayOnly`:
//   • Enemies (displayOnly=true): clear MoveTarget.active so the local movement system
//     never drives them — their Position comes purely from snapshots (otherwise the
//     receiver double-drives them, gliding past/through others between corrections).
//   • The guest's own units (displayOnly=false): simulated — predicted forward by the
//     movement system between authoritative snapshots, then reconciled.

/** Create an entity from a snapshot and register it in the occupancy grid. */
function _spawnFromSnapshot(world: SimWorld, snap: UnitSnapshot, displayOnly: boolean): void {
	const { MoveTarget, Position, Unit, UnitId } = world.components;
	const eid = addEntity(world);

	addComponent(world, eid, Position);
	addComponent(world, eid, MoveTarget);
	addComponent(world, eid, Unit);
	addComponent(world, eid, UnitId);
	_applyUnitSnapshot(world, eid, snap);
	Unit.movable[eid] = displayOnly ? 0 : 1;
	if (displayOnly) { MoveTarget.active[eid] = 0; }
	_restoreOccupancy(world, eid);
	world.eidOf.set(snap.uid, eid);
	setNextUnitId(world, snap.uid);
}

/** Overwrite an existing entity from a snapshot.  Mobile units hold no tile
 *  reservation; buildings don't move, so no occupancy bookkeeping is needed here. */
function _applyFromSnapshot(world: SimWorld, eid: number, snap: UnitSnapshot, displayOnly: boolean): void {
	const { Building, MoveTarget, Unit } = world.components;
	const isBuilding = Building.fw[eid] > 0;   // (an existing entity: it was, and stays, what it is)
	const walks = !isBuilding && world.walk !== null;

	if (walks) { freeUnit(world, eid); }         // release footprint at the OLD position first
	_applyUnitSnapshot(world, eid, snap);    // overwrites Position with the new one
	Unit.movable[eid] = displayOnly ? 0 : 1;
	if (displayOnly) { MoveTarget.active[eid] = 0; }
	if (walks) { reserveUnit(world, eid); }      // re-claim footprint at the NEW position
}

/** Add a newly-revealed enemy unit (display-only). */
export function addKnownUnit(world: SimWorld, snap: UnitSnapshot): void { _spawnFromSnapshot(world, snap, true); }
/** Refresh a known enemy unit from a new snapshot (display-only). */
export function updateKnownUnit(world: SimWorld, eid: number, snap: UnitSnapshot): void { _applyFromSnapshot(world, eid, snap, true); }
/** Despawn an enemy unit that has left visibility (free its footprint if a building). */
export function removeKnownUnit(world: SimWorld, eid: number): void {
	const { Building, Path, UnitId } = world.components;

	if (hasComponent(world, eid, Building)) { freeRect(world, Path.curTx[eid], Path.curTy[eid], Building.fw[eid], Building.fh[eid]); } else if (world.walk) { freeUnit(world, eid); }

	world.eidOf.delete(UnitId.id[eid]);
	removeEntity(world, eid);
}

/** Create a predicted own unit from a snapshot (simulated; guest prediction). */
export function addOwnUnit(world: SimWorld, snap: UnitSnapshot): void { _spawnFromSnapshot(world, snap, false); }
/** Snap a diverged predicted own unit back to its authoritative snapshot. */
export function reconcileOwnUnit(world: SimWorld, eid: number, snap: UnitSnapshot): void { _applyFromSnapshot(world, eid, snap, false); }

// ── Snapshot / restore ────────────────────────────────────────────────────────
// Full deterministic state capture.  Applying a snapshot then replaying the
// command log from that tick forward produces identical state to having run
// the sim continuously — no schema reconciliation needed.

export interface WorldSnapshot {
	"tick": number;
	"nextUnitId": number;
	"rngState": number;
	"units": UnitSnapshot[];
	"explored": [number, number[]][];   // per-team explored maps (drive fog-aware pathing)
    // Queue state keyed by stable uid — reproduces action/production/rally on restore + replay.
	"orders"?: Record<number, Order[]>;
	"production"?: Record<number, ProductionState>;
	"rally"?: Record<number, { "txFP": number; "tyFP": number }>;
    // The repeat-move memo (systems/commands.ts), per team: a repeat click after a restore takes the same branch.
	"lastMove"?: SimWorld["lastMove"];
}

/** Deep-copy a plain-data Record so the snapshot is independent of later sim mutation (or undefined). */
function cloneMap<T>(m: Record<number, T> | undefined): Record<number, T> | undefined {
	return m ? structuredClone(m) : undefined;
}

export function takeSnapshot(world: SimWorld): WorldSnapshot {
	return {
		"tick": world.tick,
		"nextUnitId": world.nextUnitId,
		"rngState": world.rng,
		"units": unitEids(world).map((e) => snapshotUnit(world, e)),
		"explored": exportExplored(world),
		"orders": cloneMap(world.orders),
		"production": cloneMap(world.production),
		"rally": cloneMap(world.rally),
		"lastMove": cloneMap(world.lastMove)
	};
}

export function applySnapshot(world: SimWorld, snap: WorldSnapshot): void {
	const { Building, MoveTarget, Position, Unit, UnitId } = world.components;

    // Despawn all live entities first
	for (const eid of unitEids(world)) {
		removeEntity(world, eid);
	}

    // Reset transient state
	world.tick = snap.tick;
	world.nextUnitId = snap.nextUnitId;
	world.eidOf.clear();
	world.rng = rngState(snap.rngState);
    // Restore queue state (entities were removed via removeEntity above, which bypasses despawn cleanup,
    // so replace the maps wholesale from the snapshot — independent copies).
	world.orders = cloneMap(snap.orders);
	world.production = cloneMap(snap.production);
	world.rally = cloneMap(snap.rally);
	world.lastMove = cloneMap(snap.lastMove);
	resetOccupancy(world);
	resetWalkGrid(world);
	resetIdleGrids(world);
	markIdleDirty(world);   // rebuild the path-obstacle grid from the restored units on next path
	clearFlowFieldCache(world);

    // Restore units — eids are freshly allocated (not preserved from snapshot)
	for (const u of snap.units) {
		const eid = addEntity(world);

		addComponent(world, eid, Position);
		addComponent(world, eid, MoveTarget);
		addComponent(world, eid, Unit);
		addComponent(world, eid, UnitId);
		Unit.selected[eid] = 0;   // local UI state — not in snapshot, reset explicitly
		_applyUnitSnapshot(world, eid, u);
		Unit.movable[eid] = Building.fw[eid] > 0 ? 0 : 1;   // referee restore: real units are movable
		_restoreOccupancy(world, eid);
		world.eidOf.set(u.uid, eid);
	}

    // Restore explored terrain (and rebuild believedPass) for fog-aware pathing.
	importExplored(world, snap.explored ?? []);
}

/** A digest of the whole sim state: every sim field of every unit (hashEntities), the tick, the RNG, the id counter,
 *  the queues, the repeat-move memo and each team's explored map — two worlds that hash alike play on alike. */
export function worldHash(world: SimWorld): number {
	let hash = hashEntities(world, unitEids(world));

	hash = fold(hash, world.tick);
	hash = fold(hash, world.rng);
	hash = fold(hash, world.nextUnitId);

    // (Records keyed by uid serialize in key order: integer keys ascend.)
	for (const char of JSON.stringify([world.orders ?? {}, world.production ?? {}, world.rally ?? {}, world.lastMove ?? {}, exportExplored(world)])) {
		hash = fold(hash, char.charCodeAt(0));
	}

	return hash;
}
