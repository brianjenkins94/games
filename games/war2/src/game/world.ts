import { createWorld, addEntity, removeEntity, addComponent, query, observe, onAdd, onRemove } from "bitecs";
import { Position, MoveTarget, Unit, UnitId, Path, UnitAnim, Building, FP, TILE_PX, WORLD_W, WORLD_H, tileCenterFP, fpToTile } from "./components";
import { unitFootprint, unitBuildTicks } from "./unitTypes";
export type { UnitSnapshot } from "./types";
import type { UnitSnapshot } from "./types";
import { movementSystem, stopUnit as _stopUnit } from "./systems/movement";
import { hashEntities } from "./hash";
import { seedRng, rngRange, getRngState, setRngState } from "./rng";
import { initPassability, getPassability, getMapW, getMapH } from "./passability";
import { initOccupancy, occupyTile, freeTile, isEmpty, resetOccupancy, occupyRect, freeRect, rectEmpty } from "./occupancy";
import { getOrComputeFlowField, clearFlowFieldCache, DIR_DX, DIR_DY, UNREACHABLE } from "./flowField";
import { inRange } from "./distance";

export interface SimWorld extends Record<string, unknown> { tick: number; }

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

/** Sight radius in tiles for all units (measured with the dodecagonal metric). */
export const FOW_SIGHT_TILES = 4;

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
    Unit.type[eid]         = typeId;
    UnitId.id[eid]         = uid;
    Path.active[eid]       = 0;
    const tx = fpToTile(xFP), ty = fpToTile(yFP);
    Path.curTx[eid]        = tx;
    Path.curTy[eid]        = ty;
    UnitAnim.dir[eid]      = 4;   // default South
    UnitAnim.moving[eid]   = 0;
    occupyTile(tx, ty, eid);
    _unitIdToEid.set(uid, eid);
    if (unitId !== undefined) setNextUnitId(unitId); // keep counter ahead
    return eid;
}

export function despawnUnit(world: SimWorld, eid: number): void {
    if (Building.fw[eid] > 0) freeRect(Path.curTx[eid], Path.curTy[eid], Building.fw[eid], Building.fh[eid]);
    else                      freeTile(Path.curTx[eid], Path.curTy[eid]);
    Path.active[eid] = 0;
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

/**
 * Render-only preview of a move command.
 *
 * Sets ONLY UnitAnim.dir and UnitAnim.moving — pure render hints that the
 * movement system overwrites on its next step and that never enter the world
 * hash or any movement decision.  Position, MoveTarget, Path, and occupancy are
 * deliberately left untouched.
 *
 * This gives instant visual feedback (the unit turns to face its goal and plays
 * its walk cycle) without advancing sim state ahead of the authoritative
 * command.  The real movement — curTx/curTy, occupancy, MoveTarget — happens
 * only via setMoveTarget applied from a command, at the same tick on
 * both sims, so there is no divergence.
 *
 * Determinism note: setting UnitAnim here is safe precisely because UnitAnim is
 * write-only from the sim's perspective (the movement system sets it; nothing
 * reads it back) and is excluded from worldHash.  Setting MoveTarget.active or
 * Path.active here would NOT be safe — the deterministic movement system acts on
 * those, which would move the predicting player's units ahead of the host.
 */
export function previewMoveTarget(_world: SimWorld, eid: number, txFP: number, tyFP: number): void {
    const pass = getPassability();
    const mapW = getMapW();

    const goalTx = fpToTile(txFP);
    const goalTy = fpToTile(tyFP);
    const curTx  = Path.curTx[eid];
    const curTy  = Path.curTy[eid];

    if (curTx === goalTx && curTy === goalTy) return;

    let dir: number;
    if (pass) {
        if (pass[goalTy * mapW + goalTx]) return;       // goal terrain-blocked
        const ff = getOrComputeFlowField(goalTx, goalTy);
        if (!ff) return;
        const myIdx = curTy * mapW + curTx;
        const d = ff.dirs[myIdx];
        if (d === UNREACHABLE) return;
        dir = d;
    } else {
        // Pre-map fallback (dev only): face the raw delta, 8-way.
        dir = octantFromDelta(txFP - Position.x[eid], tyFP - Position.y[eid]);
    }

    UnitAnim.dir[eid]    = dir;
    UnitAnim.moving[eid] = 1;
}

/** 8-way octant (0=N..7=NW) from a world-space delta. */
function octantFromDelta(dx: number, dy: number): number {
    const a = (Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
    return Math.round(a / (Math.PI / 4)) & 7;
}

/** Authoritative halt — clears movement/path/anim state (occupancy unchanged). */
export function stopUnit(_world: SimWorld, eid: number): void {
    _stopUnit(eid);
}

export function setMoveTarget(_world: SimWorld, eid: number, txFP: number, tyFP: number): void {
    const pass = getPassability();
    const mapW = getMapW();
    const mapH = getMapH();

    if (!pass) {
        // No map loaded — direct movement fallback (pre-map mode)
        MoveTarget.tx[eid]     = txFP;
        MoveTarget.ty[eid]     = tyFP;
        MoveTarget.active[eid] = 1;
        return;
    }

    const goalTx = fpToTile(txFP);
    const goalTy = fpToTile(tyFP);
    const curTx  = Path.curTx[eid];
    const curTy  = Path.curTy[eid];

    if (curTx === goalTx && curTy === goalTy) return; // already there
    if (pass[goalTy * mapW + goalTx]) return;         // goal is terrain-blocked

    // Pre-warm the cache — shared by every unit with this goal (the key benefit
    // of flow fields: all N selected units cost one Dijkstra, not N A* calls).
    const ff = getOrComputeFlowField(goalTx, goalTy);
    if (!ff) return;

    // If this unit can't reach the goal at all, skip it
    const myIdx = curTy * mapW + curTx;
    if (ff.dirs[myIdx] === UNREACHABLE) return;

    // Record goal — movement system reads the flow field each tile arrival
    Path.goalTx[eid] = goalTx;
    Path.goalTy[eid] = goalTy;
    Path.active[eid] = 1;

    // Kick off immediately: free current tile, occupy first step
    const dir = ff.dirs[myIdx];
    const nx  = curTx + DIR_DX[dir];
    const ny  = curTy + DIR_DY[dir];

    if (nx >= 0 && nx < mapW && ny >= 0 && ny < mapH && !pass[ny * mapW + nx] && isEmpty(nx, ny)) {
        freeTile(curTx, curTy);
        occupyTile(nx, ny, eid);
        Path.curTx[eid]      = nx;
        Path.curTy[eid]      = ny;
        MoveTarget.tx[eid]   = tileCenterFP(nx);
        MoveTarget.ty[eid]   = tileCenterFP(ny);
        UnitAnim.dir[eid]    = dir;   // face the direction we're stepping
        UnitAnim.moving[eid] = 1;
    } else {
        // First tile is occupied or blocked — movement system retries each tick
        MoveTarget.tx[eid]   = tileCenterFP(curTx);
        MoveTarget.ty[eid]   = tileCenterFP(curTy);
        UnitAnim.moving[eid] = 0;    // waiting, show idle
    }
    MoveTarget.active[eid] = 1;
}

// ── Visibility ────────────────────────────────────────────────────────────────

/**
 * Returns the set of stable UnitIds visible to observerTeam.
 * Own units are always included; enemy units are included if any own unit is
 * within FOW_SIGHT_TILES of them (dodecagonal distance metric, see distance.ts).
 */
export function computeVisibleUids(world: SimWorld, observerTeam: number): Set<number> {
    const eids    = unitEids(world);
    const myEids: number[] = [];
    const visible = new Set<number>();

    // Collect own-team eids and mark them visible in one pass (avoids .filter() alloc)
    for (const e of eids) {
        if (Unit.team[e] === observerTeam) { visible.add(UnitId.id[e]); myEids.push(e); }
    }
    // Check enemy proximity against the collected own-team positions
    for (const e of eids) {
        if (Unit.team[e] === observerTeam) continue;
        const etx = Path.curTx[e], ety = Path.curTy[e];
        for (const m of myEids) {
            if (inRange(Path.curTx[m] - etx, Path.curTy[m] - ety, FOW_SIGHT_TILES)) {
                visible.add(UnitId.id[e]);
                break;
            }
        }
    }
    return visible;
}

/** True if tile (tx, ty) is within FOW_SIGHT_TILES of any unit owned by observerTeam. */
export function isTileVisible(world: SimWorld, observerTeam: number, tx: number, ty: number): boolean {
    for (const e of unitEids(world)) {
        if (Unit.team[e] !== observerTeam) continue;
        if (inRange(Path.curTx[e] - tx, Path.curTy[e] - ty, FOW_SIGHT_TILES)) return true;
    }
    return false;
}

/**
 * Snapshots of ALL myTeam units.  The sender pushes these every tick; the
 * receiver filters them by their own sight range in applyEnemyStateUpdate so
 * only units genuinely within LOS are spawned.
 *
 * Sending everything solves the bootstrap deadlock: neither side starts with
 * any known enemy units so proximity-based filtering on the sender side would
 * silence both peers forever.  An honest receiver never displays units it
 * can't see; the commitment scheme catches retroactive position lies.
 */
export function ownSnapshotsVisibleTo(world: SimWorld, myTeam: number): UnitSnapshot[] {
    return unitEids(world)
        .filter(e => Unit.team[e] === myTeam)
        .map(snapshotUnit);
}

/** Snapshot the full state of a single entity. */
export function snapshotUnit(eid: number): UnitSnapshot {
    return {
        uid:        UnitId.id[eid],
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
        dir:        UnitAnim.dir[eid],
        moving:     UnitAnim.moving[eid],
        bw:         Building.fw[eid],
        bh:         Building.fh[eid],
        buildLeft:  Building.buildLeft[eid],
    };
}

/**
 * FNV-1a commitment hash over positions of own units NOT currently visible to
 * the opponent, seeded with a per-tick nonce.  The opponent stores this each
 * tick; when a unit exits fog the owner sends the nonce so the receiver can
 * verify the unit's position was not fabricated after the fact.
 */
export function hiddenUnitsHash(world: SimWorld, myTeam: number, nonce: number, visibleToOpp: Set<number>): number {
    const hidden = unitEids(world)
        .filter(e => Unit.team[e] === myTeam && !visibleToOpp.has(UnitId.id[e]))
        .sort((a, b) => UnitId.id[a] - UnitId.id[b]);
    let h = nonce >>> 0;
    for (const e of hidden) {
        h = Math.imul(h ^ (Position.x[e] | 0), 16777619) >>> 0;
        h = Math.imul(h ^ (Position.y[e] | 0), 16777619) >>> 0;
    }
    return h;
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
    UnitAnim.dir[eid]      = snap.dir;
    UnitAnim.moving[eid]   = snap.moving;
    Building.fw[eid]        = snap.bw;
    Building.fh[eid]        = snap.bh;
    Building.buildLeft[eid] = snap.buildLeft;
}

/** Re-lay occupancy for a restored entity: footprint rect for buildings, else
 *  a single tile.  Buildings also need their Building component (re-)added so
 *  the construction query finds them. */
function _restoreOccupancy(world: SimWorld, eid: number, snap: UnitSnapshot): void {
    if (snap.bw > 0) {
        addComponent(world, eid, Building);
        occupyRect(snap.curTx, snap.curTy, snap.bw, snap.bh, eid);
    } else {
        occupyTile(snap.curTx, snap.curTy, eid);
    }
}

/** Add a newly-revealed enemy unit and register it in the occupancy grid. */
export function addKnownUnit(world: SimWorld, snap: UnitSnapshot): void {
    const eid = addEntity(world);
    addComponent(world, eid, Position);
    addComponent(world, eid, MoveTarget);
    addComponent(world, eid, Unit);
    addComponent(world, eid, UnitId);
    _applyUnitSnapshot(eid, snap);
    _restoreOccupancy(world, eid, snap);
    _unitIdToEid.set(snap.uid, eid);
    setNextUnitId(snap.uid);
}

/**
 * Refresh a known enemy unit from a new snapshot.
 * Moves the occupancy registration if the unit changed tiles.
 */
export function updateKnownUnit(eid: number, snap: UnitSnapshot): void {
    const oldTx = Path.curTx[eid], oldTy = Path.curTy[eid];
    _applyUnitSnapshot(eid, snap);
    if (snap.curTx !== oldTx || snap.curTy !== oldTy) {
        freeTile(oldTx, oldTy);
        occupyTile(snap.curTx, snap.curTy, eid);
    }
}

/** Despawn an enemy unit that has left visibility and free its tile. */
export function removeKnownUnit(world: SimWorld, eid: number): void {
    freeTile(Path.curTx[eid], Path.curTy[eid]);
    _unitIdToEid.delete(UnitId.id[eid]);
    removeEntity(world, eid);
}

/** Advance construction on all buildings (one tick of progress). */
function buildingSystem(world: SimWorld): void {
    for (const eid of query(world, [Building])) {
        if (Building.buildLeft[eid] > 0) Building.buildLeft[eid]--;
    }
}

export function stepWorld(world: SimWorld): void {
    movementSystem(world);
    buildingSystem(world);
    world.tick++;
}

export function unitEids(world: SimWorld): number[] {
    return [...query(world, [Position, Unit, MoveTarget])];
}

// ── Snapshot / restore ────────────────────────────────────────────────────────
// Full deterministic state capture.  Applying a snapshot then replaying the
// command log from that tick forward produces identical state to having run
// the sim continuously — no schema reconciliation needed.

export interface WorldSnapshot {
    tick: number;
    nextUnitId: number;
    rngState: number;
    units: UnitSnapshot[];
}

export function takeSnapshot(world: SimWorld): WorldSnapshot {
    return {
        tick:       world.tick,
        nextUnitId: _nextUnitId,
        rngState:   getRngState(),
        units:      unitEids(world).map(snapshotUnit),
    };
}

export function applySnapshot(world: SimWorld, snap: WorldSnapshot): void {
    // Despawn all live entities first
    const existing = [...unitEids(world)];
    for (const eid of existing) {
        _unitIdToEid.delete(UnitId.id[eid]);
        removeEntity(world, eid);
    }

    // Reset transient state
    world.tick     = snap.tick;
    _nextUnitId    = snap.nextUnitId;
    _unitIdToEid.clear();
    setRngState(snap.rngState);
    resetOccupancy();
    clearFlowFieldCache();

    // Restore units — eids are freshly allocated (not preserved from snapshot)
    for (const u of snap.units) {
        const eid = addEntity(world);
        addComponent(world, eid, Position);
        addComponent(world, eid, MoveTarget);
        addComponent(world, eid, Unit);
        addComponent(world, eid, UnitId);
        Unit.selected[eid] = 0;   // local UI state — not in snapshot, reset explicitly
        _applyUnitSnapshot(eid, u);
        _restoreOccupancy(world, eid, u);
        _unitIdToEid.set(u.uid, eid);
    }
}
