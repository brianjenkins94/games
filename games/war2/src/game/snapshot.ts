/**
 * Snapshot / serialization & received-entity sync — capturing the full sim state and restoring it,
 * plus the lifecycle of entities created from snapshots pushed over the wire (display-only enemies and
 * the guest's predicted own units).  Split out of world.ts.
 *
 * Determinism: applying a snapshot then replaying the command log from that tick forward yields
 * identical state to running the sim continuously — no schema reconciliation.  The unit-ID registry it
 * touches lives in world.ts (single owner, shared with spawn/despawn); this module drives it through
 * the exported accessors.
 */
import { addEntity, removeEntity, addComponent, hasComponent } from "bitecs";
import { Position, MoveTarget, Unit, UnitId, Path, UnitAnim, Building } from "./components";
import type { UnitSnapshot, Order, ProductionState } from "./types";
import { occupyRect, freeRect, resetOccupancy } from "./occupancy";
import { reserveUnit, freeUnit, resetWalkGrid } from "./walkGrid";
import { resetIdleGrids, markIdleDirty } from "./pathObstacles";
import { clearFlowFieldCache } from "./flowField";
import { getRngState, setRngState } from "./rng";
import { exportExplored, importExplored } from "./vision";
import { hashEntities } from "./hash";
import {
    unitEids, setNextUnitId,
    getNextUnitId, resetUnitRegistry, registerUnitId, unregisterUnitId,
    type SimWorld,
} from "./world";

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
    return unitEids(world)
        .filter(e => Unit.team[e] === myTeam)
        .map(e => snapshotUnit(world, e));
}

/** Snapshot the full state of a single entity. */
export function snapshotUnit(world: SimWorld, eid: number): UnitSnapshot {
    // Footprint only when the entity actually has the Building component — never read the (module-global,
    // possibly recycled) fw/fh array as a proxy for "is a building".
    const isBuilding = hasComponent(world, eid, Building);
    const uid = UnitId.id[eid];
    // Queue state (copied, not aliased): the wire delta comparator (protocol.unitSnapshotChanged) diffs
    // successive snapshots, so it must see independent values — production mutates its state object in
    // place each tick, which would otherwise read as "unchanged".
    const orders = world.orders?.[uid];
    const prod   = isBuilding ? world.production?.[uid] : undefined;
    const rally  = isBuilding ? world.rally?.[uid] : undefined;
    return {
        uid,
        team:       Unit.team[eid],
        type:       Unit.type[eid],
        x:          Position.x[eid],
        y:          Position.y[eid],
        mtx:        MoveTarget.tx[eid],
        mty:        MoveTarget.ty[eid],
        moveActive: MoveTarget.active[eid],
        curTx:      Path.curTx[eid],
        curTy:      Path.curTy[eid],
        goalTx:     Path.goalTx[eid],
        goalTy:     Path.goalTy[eid],
        pathActive: Path.active[eid],
        stuckTicks: Path.stuckTicks[eid],
        dir:        UnitAnim.dir[eid],
        moving:     UnitAnim.moving[eid],
        bw:         isBuilding ? Building.fw[eid] : 0,
        bh:         isBuilding ? Building.fh[eid] : 0,
        buildLeft:  isBuilding ? Building.buildLeft[eid] : 0,
        ...(orders && orders.length ? { orders: orders.map(o => ({ ...o })) } : {}),
        ...(prod  ? { prod: { queue: [...prod.queue], ticksLeft: prod.ticksLeft, ticksTotal: prod.ticksTotal } } : {}),
        ...(rally ? { rally: { ...rally } } : {}),
    };
}

// ── Hash (own-team only) ──────────────────────────────────────────────────────

/** Hash covering only the local team's units — the authoritative portion of the sim. */
export function worldHashOwn(world: SimWorld, myTeam: number): number {
    return hashEntities(unitEids(world).filter(e => Unit.team[e] === myTeam));
}

// ── Known-enemy lifecycle (receiver side) ────────────────────────────────────
// Enemy units are display-only on the receiving peer: they are not registered
// in the occupancy grid and never call setMoveTarget.  Their positions come
// entirely from STATE_UPDATE snapshots pushed by the owning peer each tick.

function _applyUnitSnapshot(eid: number, snap: UnitSnapshot): void {
    Position.x[eid]        = snap.x;
    Position.y[eid]        = snap.y;
    MoveTarget.tx[eid]     = snap.mtx;
    MoveTarget.ty[eid]     = snap.mty;
    MoveTarget.active[eid] = snap.moveActive;
    Unit.team[eid]         = snap.team;
    Unit.type[eid]         = snap.type;
    // Unit.selected is local UI state — never overwrite it from a received snapshot
    UnitId.id[eid]         = snap.uid;
    Path.active[eid]       = snap.pathActive;
    Path.goalTx[eid]       = snap.goalTx;
    Path.goalTy[eid]       = snap.goalTy;
    Path.curTx[eid]        = snap.curTx;
    Path.curTy[eid]        = snap.curTy;
    Path.stuckTicks[eid]   = snap.stuckTicks;
    UnitAnim.dir[eid]      = snap.dir;
    UnitAnim.moving[eid]   = snap.moving;
    Building.fw[eid]        = snap.bw;
    Building.fh[eid]        = snap.bh;
    Building.buildLeft[eid] = snap.buildLeft;
}

/** Re-lay occupancy for a restored entity.  Only buildings reserve tiles now
 *  (their footprint rect); mobile units collide continuously and reserve nothing.
 *  Buildings also need their Building component (re-)added so the construction
 *  query finds them. */
function _restoreOccupancy(world: SimWorld, eid: number, snap: UnitSnapshot): void {
    if (snap.bw > 0) {
        addComponent(world, eid, Building);
        occupyRect(snap.curTx, snap.curTy, snap.bw, snap.bh, eid);
    } else {
        reserveUnit(eid);   // mobile / display-only unit: claim its 8px footprint
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
    const eid = addEntity(world);
    addComponent(world, eid, Position);
    addComponent(world, eid, MoveTarget);
    addComponent(world, eid, Unit);
    addComponent(world, eid, UnitId);
    _applyUnitSnapshot(eid, snap);
    Unit.movable[eid] = displayOnly ? 0 : 1;
    if (displayOnly) MoveTarget.active[eid] = 0;
    _restoreOccupancy(world, eid, snap);
    registerUnitId(snap.uid, eid);
    setNextUnitId(snap.uid);
}

/** Overwrite an existing entity from a snapshot.  Mobile units hold no tile
 *  reservation; buildings don't move, so no occupancy bookkeeping is needed here. */
function _applyFromSnapshot(eid: number, snap: UnitSnapshot, displayOnly: boolean): void {
    const isBuilding = snap.bw > 0;
    if (!isBuilding) freeUnit(eid);          // release footprint at the OLD position first
    _applyUnitSnapshot(eid, snap);           // overwrites Position with the new one
    Unit.movable[eid] = displayOnly ? 0 : 1;
    if (displayOnly) MoveTarget.active[eid] = 0;
    if (!isBuilding) reserveUnit(eid);       // re-claim footprint at the NEW position
}

/** Add a newly-revealed enemy unit (display-only). */
export function addKnownUnit(world: SimWorld, snap: UnitSnapshot): void { _spawnFromSnapshot(world, snap, true); }
/** Refresh a known enemy unit from a new snapshot (display-only). */
export function updateKnownUnit(eid: number, snap: UnitSnapshot): void { _applyFromSnapshot(eid, snap, true); }
/** Despawn an enemy unit that has left visibility (free its footprint if a building). */
export function removeKnownUnit(world: SimWorld, eid: number): void {
    if (hasComponent(world, eid, Building)) freeRect(Path.curTx[eid], Path.curTy[eid], Building.fw[eid], Building.fh[eid]);
    else                      freeUnit(eid);
    unregisterUnitId(UnitId.id[eid]);
    removeEntity(world, eid);
}

/** Create a predicted own unit from a snapshot (simulated; guest prediction). */
export function addOwnUnit(world: SimWorld, snap: UnitSnapshot): void { _spawnFromSnapshot(world, snap, false); }
/** Snap a diverged predicted own unit back to its authoritative snapshot. */
export function reconcileOwnUnit(eid: number, snap: UnitSnapshot): void { _applyFromSnapshot(eid, snap, false); }

// ── Snapshot / restore ────────────────────────────────────────────────────────
// Full deterministic state capture.  Applying a snapshot then replaying the
// command log from that tick forward produces identical state to having run
// the sim continuously — no schema reconciliation needed.

export interface WorldSnapshot {
    tick: number;
    nextUnitId: number;
    rngState: number;
    units: UnitSnapshot[];
    explored: [number, number[]][];   // per-team explored maps (drive fog-aware pathing)
    // Queue state keyed by stable uid — reproduces action/production/rally on restore + replay.
    orders?: Record<number, Order[]>;
    production?: Record<number, ProductionState>;
    rally?: Record<number, { txFP: number; tyFP: number }>;
}

/** Deep-copy a plain-data Record so the snapshot is independent of later sim mutation (or undefined). */
function cloneMap<T>(m: Record<number, T> | undefined): Record<number, T> | undefined {
    return m ? structuredClone(m) : undefined;
}

export function takeSnapshot(world: SimWorld): WorldSnapshot {
    return {
        tick:       world.tick,
        nextUnitId: getNextUnitId(),
        rngState:   getRngState(),
        units:      unitEids(world).map(e => snapshotUnit(world, e)),
        explored:   exportExplored(),
        orders:     cloneMap(world.orders),
        production: cloneMap(world.production),
        rally:      cloneMap(world.rally),
    };
}

export function applySnapshot(world: SimWorld, snap: WorldSnapshot): void {
    // Despawn all live entities first
    const existing = [...unitEids(world)];
    for (const eid of existing) {
        unregisterUnitId(UnitId.id[eid]);
        removeEntity(world, eid);
    }

    // Reset transient state
    world.tick     = snap.tick;
    resetUnitRegistry(snap.nextUnitId);   // _nextUnitId = snap.nextUnitId; clear the uid→eid map
    setRngState(snap.rngState);
    // Restore queue state (entities were removed via removeEntity above, which bypasses despawn cleanup,
    // so replace the maps wholesale from the snapshot — independent copies).
    world.orders     = cloneMap(snap.orders);
    world.production = cloneMap(snap.production);
    world.rally      = cloneMap(snap.rally);
    resetOccupancy();
    resetWalkGrid();
    resetIdleGrids();
    markIdleDirty();   // rebuild the path-obstacle grid from the restored units on next path
    clearFlowFieldCache();

    // Restore units — eids are freshly allocated (not preserved from snapshot)
    for (const u of snap.units) {
        const eid = addEntity(world);
        addComponent(world, eid, Position);
        addComponent(world, eid, MoveTarget);
        addComponent(world, eid, Unit);
        addComponent(world, eid, UnitId);
        Unit.selected[eid] = 0;   // local UI state — not in snapshot, reset explicitly
        Unit.movable[eid]  = u.bw > 0 ? 0 : 1;   // referee restore: real units are movable
        _applyUnitSnapshot(eid, u);
        _restoreOccupancy(world, eid, u);
        registerUnitId(u.uid, eid);
    }

    // Restore explored terrain (and rebuild believedPass) for fog-aware pathing.
    importExplored(snap.explored ?? []);
}
