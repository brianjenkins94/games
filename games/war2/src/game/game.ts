/**
 * GameInstance — the public API surface of the sim.
 *
 * Wraps world.ts helpers into a single object so client/main.ts (the netcode
 * orchestrator) never imports from game/world.ts directly, and game logic
 * stays fully decoupled from transport concerns.
 */
import {
    createSimWorld, stepWorld, unitEids as _unitEids, worldHashOwn,
    spawnUnit as _spawnUnit, spawnRandom as _spawnRandom, despawnUnit,
    setMoveTarget as _setMoveTarget, previewMoveTarget as _previewMoveTarget,
    canPlaceBuilding as _canPlaceBuilding,
    takeSnapshot as _takeSnapshot, applySnapshot as _applySnapshot,
    registerObservers as _registerObservers,
    consumeUnitId, eidForUnitId, setNextUnitId, initUnitIdCounter,
    computeVisibleUids, ownSnapshotsVisibleTo, isTileVisible,
    snapshotUnit as _snapshotUnit,
    addKnownUnit as _addKnownUnit, updateKnownUnit as _updateKnownUnit,
    removeKnownUnit as _removeKnownUnit,
    addOwnUnit as _addOwnUnit, reconcileOwnUnit as _reconcileOwnUnit,
    type SimWorld, type UnitLifecycle, type MapInfo, type WorldSnapshot, type UnitSnapshot,
} from "./world";

export type { WorldSnapshot, UnitSnapshot };

export type { MapInfo };
import { applyCommands as _applyCommands } from "./systems/commands";
import type { Command } from "../net/protocol";

export type { SimWorld, UnitLifecycle };

export interface GameInstance {
    /** Underlying bitecs world — exposed for schema helpers that need raw access. */
    readonly world: SimWorld;

    /** Advance the sim one tick (runs all systems, increments world.tick). */
    step(): void;

    /** Current list of all unit entity IDs. */
    unitEids(): number[];

    /** Spawn a unit at the given fixed-point coordinates. `typeId` is an
     *  interned unit-type id (see game/unitTypes.ts); 0 = none/unknown. */
    spawnUnit(xFP: number, yFP: number, team: number, unitId?: number, typeId?: number): number;

    /** Spawn a unit at a random position within the world bounds. */
    spawnRandom(team: number): number;

    /** Remove a unit by its bitecs eid. */
    despawnUnit(eid: number): void;

    /** Set the move target for a unit (authoritative — changes curTx/curTy and occupancy). */
    setMoveTarget(eid: number, txFP: number, tyFP: number): void;
    /** Visual-only preview — sets goal and animation but not occupancy.  Call on click. */
    previewMoveTarget(eid: number, txFP: number, tyFP: number): void;
    /** Capture full deterministic sim state for snapshot+replay reconciliation. */
    takeSnapshot(): WorldSnapshot;
    /** Reset sim to a previously captured snapshot. */
    applySnapshot(snap: WorldSnapshot): void;

    /** Apply a batch of commands (MOVE / SPAWN / STOP / BUILD) to the sim. */
    applyCommands(cmds: Command[]): void;

    /** True if a building of `typeId` can be placed with footprint top-left at (tileX,tileY). */
    canPlaceBuilding(tileX: number, tileY: number, typeId: number): boolean;

    /** Register bitecs observers for unit spawn/despawn events. */
    registerObservers(hooks: UnitLifecycle): void;

    // ── Unit-ID helpers ────────────────────────────────────────────────────
    consumeUnitId(): number;
    eidForUnitId(uid: number): number | undefined;
    setNextUnitId(n: number): void;
    /** Initialise the ID counter for the local team's ID space. */
    initUnitIdCounter(team: number): void;

    // ── Fog of war / partial sim ────────────────────────────────────────────
    /** Set of stable UnitIds visible to observerTeam (own + in-sight enemies). */
    computeVisibleUids(observerTeam: number): Set<number>;
    /** Snapshots of all myTeam units (receiver filters by their own LOS). */
    ownSnapshotsVisibleTo(myTeam: number): UnitSnapshot[];
    /** True if tile (tx, ty) is within sight range of any unit on observerTeam. */
    isTileVisible(observerTeam: number, tx: number, ty: number): boolean;
    /** Hash covering only own-team units (authoritative portion of the sim). */
    hashOwn(myTeam: number): number;
    /** Snapshot a single entity's full state. */
    snapshotUnit(eid: number): UnitSnapshot;
    /** Add a newly-revealed enemy unit (no occupancy registration). */
    addKnownUnit(snap: UnitSnapshot): void;
    /** Refresh a known enemy unit from a new snapshot. */
    updateKnownUnit(eid: number, snap: UnitSnapshot): void;
    /** Despawn an enemy unit that has left visibility. */
    removeKnownUnit(eid: number): void;
    /** Create a predicted own unit from a snapshot (simulated; guest prediction). */
    addOwnUnit(snap: UnitSnapshot): void;
    /** Snap a diverged predicted own unit back to its authoritative snapshot. */
    reconcileOwnUnit(eid: number, snap: UnitSnapshot): void;
}

export function createGame(seed: number, mapInfo?: MapInfo): GameInstance {
    const world = createSimWorld(seed, mapInfo);
    return {
        world,
        step:              ()                       => stepWorld(world),
        unitEids:          ()                       => _unitEids(world),
        spawnUnit:         (xFP, yFP, team, uid?, typeId?) => _spawnUnit(world, xFP, yFP, team, uid, typeId),
        spawnRandom:       (team)                   => _spawnRandom(world, team),
        despawnUnit:       (eid)                    => despawnUnit(world, eid),
        setMoveTarget:     (eid, txFP, tyFP)        => _setMoveTarget(world, eid, txFP, tyFP),
        previewMoveTarget: (eid, txFP, tyFP)        => _previewMoveTarget(world, eid, txFP, tyFP),
        takeSnapshot:      ()                        => _takeSnapshot(world),
        applySnapshot:     (snap)                    => _applySnapshot(world, snap),
        applyCommands:     (cmds)                   => _applyCommands(world, cmds),
        canPlaceBuilding:  (tileX, tileY, typeId)   => _canPlaceBuilding(world, tileX, tileY, typeId),
        registerObservers: (hooks)                  => _registerObservers(world, hooks),
        consumeUnitId:          ()                                   => consumeUnitId(),
        eidForUnitId:           (uid)                                => eidForUnitId(uid),
        setNextUnitId:          (n)                                  => setNextUnitId(n),
        initUnitIdCounter:      (team)                               => initUnitIdCounter(team),
        computeVisibleUids:       (observerTeam)                     => computeVisibleUids(world, observerTeam),
        ownSnapshotsVisibleTo:    (myTeam)                           => ownSnapshotsVisibleTo(world, myTeam),
        isTileVisible:            (observerTeam, tx, ty)             => isTileVisible(world, observerTeam, tx, ty),
        hashOwn:                (t)                                  => worldHashOwn(world, t),
        snapshotUnit:           (eid)                                => _snapshotUnit(eid),
        addKnownUnit:           (snap)                               => _addKnownUnit(world, snap),
        updateKnownUnit:        (eid, snap)                          => _updateKnownUnit(eid, snap),
        removeKnownUnit:        (eid)                                => _removeKnownUnit(world, eid),
        addOwnUnit:             (snap)                               => _addOwnUnit(world, snap),
        reconcileOwnUnit:       (eid, snap)                          => _reconcileOwnUnit(eid, snap),
    };
}
