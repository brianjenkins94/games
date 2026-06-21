import { createWorld, addEntity, removeEntity, addComponent, query, observe, onAdd, onRemove } from "bitecs";
import { Position, MoveTarget, Unit, UnitId, Path, UnitAnim, Building, FP, TILE_PX, WORLD_W, WORLD_H, fpToTile } from "./components";
import { unitFootprint, unitBuildTicks, unitRadiusPx } from "./unitTypes";
export type { UnitSnapshot } from "./types";
import { movementSystem } from "./systems/movement";
import { seedRng, rngRange } from "./rng";
import { initPassability, getPassability, getMapW } from "./passability";
import { initOccupancy, occupyRect, freeRect, rectEmpty } from "./occupancy";
import { initWalkGrid, reserveUnit, freeUnit } from "./walkGrid";
import { initPathObstacles, markIdleDirty, isIdleDirty, clearIdleDirty, resetIdleGrids, addIdleCSpace } from "./pathObstacles";
import { initLocalPath } from "./localPath";
import { clearFlowFieldCache } from "./flowField";
import { initVision, visionSystem, FOW_SIGHT_TILES } from "./vision";

// Re-exported for callers that historically imported it from world.ts; the
// canonical definition now lives in vision.ts (single source for the sim metric).
export { FOW_SIGHT_TILES };

export interface SimWorld extends Record<string, unknown> {
    tick: number;
    /** Last MOVE per team — target tile + a signature of the selected unit set.  A repeat
     *  click by the *same* selection on the *same* tile converges the group on the point
     *  instead of holding formation (see systems/commands.ts).  Keying on the selection
     *  lets a player cycle control groups onto one spot, each getting its own first-click
     *  formation. */
    lastMove?: Record<number, { tileX: number; tileY: number; sig: number }>;
    /** Active gather target block per team (slot centres, fixed-point).  Set by a converge
     *  move; a settling unit of this team claims the nearest still-free slot so the block
     *  fills in contiguously with no holes (see systems/movement.ts).  Cleared by any
     *  non-converge move for the team. */
    gatherSlots?: Record<number, Array<[number, number]>>;
}

// ── Observers (bitecs 0.4) ────────────────────────────────────────────────────
// Use onAdd/onRemove to react to unit lifecycle rather than polling.
// Other systems (renderer, net) can call registerObservers() after world creation.

export type UnitLifecycle = {
    onSpawn?:   (eid: number) => void;
    onDespawn?: (eid: number) => void;
};

export function registerObservers(world: SimWorld, hooks: UnitLifecycle): void {
    if (hooks.onSpawn)   observe(world, onAdd(Position, Unit, MoveTarget),    hooks.onSpawn);
    if (hooks.onDespawn) observe(world, onRemove(Position, Unit, MoveTarget), hooks.onDespawn);
}

// ── Fog-of-war constants ──────────────────────────────────────────────────────

// ── Unit ID counter ───────────────────────────────────────────────────────────
// Stable identity independent of bitecs eid.
//
// ID spaces are split by team to prevent collisions when enemy units are
// revealed via STATE_UPDATE packets:
//   team 0 → IDs 1 … 0x7FFFFFFF   (high bit clear)
//   team 1 → IDs 0x80000001 … 0xFFFFFFFF  (high bit set)
//
// Call initUnitIdCounter(myTeam) once per peer before spawning any units.

let _nextUnitId = 1;
const _unitIdToEid = new Map<number, number>();

/** Initialise the counter for the local team (call exactly once at game start). */
export function initUnitIdCounter(team: number): void {
    _nextUnitId = team === 0 ? 1 : 0x80000001;
}

/** Take the next available unit ID for this peer's team. */
export function consumeUnitId(): number {
    return _nextUnitId++;
}

/**
 * Advance the counter if a received ID is ahead of us and in our ID space.
 * (Called when we learn about a new own-team unit — e.g. from a snapshot replay.)
 */
export function setNextUnitId(n: number): void {
    const myHighBit = _nextUnitId >= 0x80000000;
    const nHighBit  = n >= 0x80000000;
    if (myHighBit === nHighBit && n >= _nextUnitId) _nextUnitId = n + 1;
}

/** Returns the local bitecs eid for a given stable unit ID, or undefined. */
export function eidForUnitId(uid: number): number | undefined { return _unitIdToEid.get(uid); }

// ── Registry accessors (for snapshot.ts, which shares this state) ──────────────
// The unit-ID counter + uid→eid map are owned here (tied to spawn/despawn); snapshot
// capture/restore drives them through these so the state stays single-owned.

/** Current next-unit-id — read by snapshot capture. */
export function getNextUnitId(): number { return _nextUnitId; }
/** Restore the registry for a snapshot apply: set the counter and clear the uid→eid map. */
export function resetUnitRegistry(nextUnitId: number): void { _nextUnitId = nextUnitId; _unitIdToEid.clear(); }
/** Record a uid→eid mapping (spawn-from-snapshot / restore). */
export function registerUnitId(uid: number, eid: number): void { _unitIdToEid.set(uid, eid); }
/** Drop a uid→eid mapping (despawn-from-snapshot). */
export function unregisterUnitId(uid: number): void { _unitIdToEid.delete(uid); }

// ── World factory ─────────────────────────────────────────────────────────────

export interface MapInfo {
    gids:       number[];   // flat tile GID array from the map's tile layer
    mapW:       number;
    mapH:       number;
    terrainArr: number[];   // terrain.json[tilesetName], indexed by GID
}

export function createSimWorld(seed: number, mapInfo?: MapInfo): SimWorld {
    _nextUnitId = 1;
    _unitIdToEid.clear();
    clearFlowFieldCache();

    if (mapInfo) {
        initPassability(mapInfo.gids, mapInfo.mapW, mapInfo.mapH, mapInfo.terrainArr);
        initOccupancy(mapInfo.mapW, mapInfo.mapH);
        initWalkGrid(mapInfo.mapW, mapInfo.mapH);   // 8px unit-collision reservation grid
        initPathObstacles(mapInfo.mapW, mapInfo.mapH);   // per-team settled-unit grid for pathing
        initLocalPath(mapInfo.mapW, mapInfo.mapH);        // scratch for the short-range unit-aware A*

        // Referee holds per-team vision for both teams (each paths on its own knowledge).
        initVision(mapInfo.mapW, mapInfo.mapH, [0, 1]);
    }

    const world = createWorld() as SimWorld;
    world.tick  = 0;
    seedRng(seed);
    return world;
}

// ── Entity helpers ────────────────────────────────────────────────────────────

/**
 * Spawn a unit with an explicit stable unitId (use when applying a received
 * SPAWN command) or let the counter auto-assign one (initial world setup).
 */
export function spawnUnit(world: SimWorld, xFP: number, yFP: number, team: number, unitId?: number, typeId = 0): number {
    const uid = unitId !== undefined ? unitId : consumeUnitId();
    const eid = addEntity(world);
    addComponent(world, eid, Position);
    addComponent(world, eid, MoveTarget);
    addComponent(world, eid, Unit);
    addComponent(world, eid, UnitId);
    Position.x[eid]        = xFP;
    Position.y[eid]        = yFP;
    MoveTarget.active[eid] = 0;
    Unit.team[eid]         = team;
    Unit.selected[eid]     = 0;
    Unit.movable[eid]      = 1;   // locally simulated
    Unit.type[eid]         = typeId;
    UnitId.id[eid]         = uid;
    Path.active[eid]       = 0;
    Path.stuckTicks[eid]   = 0;
    Path.curTx[eid]        = fpToTile(xFP);   // current tile (recomputed each move tick)
    Path.curTy[eid]        = fpToTile(yFP);
    UnitAnim.dir[eid]      = 4;   // default South
    UnitAnim.moving[eid]   = 0;
    reserveUnit(eid);             // claim the unit's footprint on the 8px collision grid
    markIdleDirty();              // a new idle unit joins the path-obstacle set
    _unitIdToEid.set(uid, eid);
    if (unitId !== undefined) setNextUnitId(unitId); // keep counter ahead
    return eid;
}

export function despawnUnit(world: SimWorld, eid: number): void {
    if (Building.fw[eid] > 0) {
        freeRect(Path.curTx[eid], Path.curTy[eid], Building.fw[eid], Building.fh[eid]);
        clearFlowFieldCache();   // footprint freed → cached fields routed around it are stale
    } else {
        freeUnit(eid);           // release the unit's footprint on the collision grid
    }
    Path.active[eid] = 0;
    markIdleDirty();             // a unit left the path-obstacle set
    _unitIdToEid.delete(UnitId.id[eid]);
    removeEntity(world, eid);
}

/** True if a building of the given type fits at footprint top-left (tileX,tileY):
 *  every footprint tile in-bounds, passable terrain, and unoccupied. */
export function canPlaceBuilding(_world: SimWorld, tileX: number, tileY: number, typeId: number): boolean {
    const [fw, fh] = unitFootprint(typeId);
    const pass = getPassability();
    const mapW = getMapW();
    if (pass) {
        for (let y = 0; y < fh; y++)
            for (let x = 0; x < fw; x++)
                if (pass[(tileY + y) * mapW + (tileX + x)]) return false; // terrain-blocked
    }
    return rectEmpty(tileX, tileY, fw, fh);
}

/** Spawn a building entity occupying its footprint, with construction in progress.
 *  Shares the unit pool (Position/Unit/UnitId + inert MoveTarget/Path/UnitAnim). */
export function spawnBuilding(world: SimWorld, tileX: number, tileY: number, team: number, typeId: number, unitId?: number): number {
    const uid = unitId !== undefined ? unitId : consumeUnitId();
    const [fw, fh] = unitFootprint(typeId);
    const eid = addEntity(world);
    addComponent(world, eid, Position);
    addComponent(world, eid, MoveTarget);
    addComponent(world, eid, Unit);
    addComponent(world, eid, UnitId);
    addComponent(world, eid, Building);
    Position.x[eid]        = tileX * TILE_PX * FP + ((fw * TILE_PX) >> 1) * FP;
    Position.y[eid]        = tileY * TILE_PX * FP + ((fh * TILE_PX) >> 1) * FP;
    MoveTarget.active[eid] = 0;
    Unit.team[eid]         = team;
    Unit.selected[eid]     = 0;
    Unit.movable[eid]      = 0;   // buildings never move (also excluded by Building.fw guard)
    Unit.type[eid]         = typeId;
    UnitId.id[eid]         = uid;
    Path.active[eid]       = 0;
    Path.curTx[eid]        = tileX;   // footprint top-left — anchors occupancy restore
    Path.curTy[eid]        = tileY;
    UnitAnim.dir[eid]      = 4;
    UnitAnim.moving[eid]   = 0;
    Building.fw[eid]        = fw;
    Building.fh[eid]        = fh;
    Building.buildLeft[eid] = unitBuildTicks(typeId);
    occupyRect(tileX, tileY, fw, fh, eid);
    clearFlowFieldCache();   // new footprint → units must route around it now
    _unitIdToEid.set(uid, eid);
    if (unitId !== undefined) setNextUnitId(unitId);
    return eid;
}

export function spawnRandom(world: SimWorld, team: number): number {
    return spawnUnit(
        world,
        rngRange(40 * FP, WORLD_W - 40 * FP),
        rngRange(40 * FP, WORLD_H - 40 * FP),
        team,
    );
}

/** Advance construction on all buildings (one tick of progress). */
function buildingSystem(world: SimWorld): void {
    for (const eid of query(world, [Building])) {
        if (Building.buildLeft[eid] > 0) Building.buildLeft[eid]--;
    }
}

/**
 * Rebuild the per-team settled-unit obstacle grid (read by the short-range local A*, localPath.ts)
 * when the idle set has changed.  Cheap no-op when nothing settled/moved since the last call.  This
 * deliberately does NOT touch the flow-field cache — the flow field is terrain-only, so units never
 * invalidate it (that separation is what keeps pathing cheap under combat churn).
 */
export function refreshPathObstacles(world: SimWorld): void {
    if (!isIdleDirty()) return;
    resetIdleGrids();
    const MOVER_R = TILE_PX >> 1;   // assume a ~tile mover for the shared C-space (land units)
    for (const eid of unitEids(world)) {
        if (Building.fw[eid] > 0 || Unit.movable[eid] !== 1) continue;   // buildings / display-only
        if (MoveTarget.active[eid] === 1) continue;                       // moving → not an obstacle
        // 8px C-space: a mover's centre may not come within (mover r + this unit's r) of this centre.
        addIdleCSpace(Unit.team[eid], Position.x[eid] / FP, Position.y[eid] / FP, MOVER_R + unitRadiusPx(Unit.type[eid]));
    }
    clearIdleDirty();
}

export function stepWorld(world: SimWorld): void {
    refreshPathObstacles(world);   // settled-unit obstacle grid current before movers path this tick
    movementSystem(world);
    buildingSystem(world);
    visionSystem(world);   // accumulate explored tiles from post-move LOS (deterministic)
    world.tick++;
}

export function unitEids(world: SimWorld): number[] {
    return [...query(world, [Position, Unit, MoveTarget])];
}
