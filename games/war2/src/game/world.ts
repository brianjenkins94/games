import { createWorld, addEntity, removeEntity, addComponent, query, observe, onAdd, onRemove } from "bitecs";
import { Position, MoveTarget, Unit, UnitId, Path, UnitAnim, Building, FP, TILE_PX, WALK_PX, WORLD_W, WORLD_H, tileCenterFP, fpToTile, snapWalkFP } from "./components";
import { unitFootprint, unitBuildTicks, unitSight, unitRadiusPx } from "./unitTypes";
export type { UnitSnapshot } from "./types";
import type { UnitSnapshot } from "./types";
import { movementSystem, stopUnit as _stopUnit } from "./systems/movement";
import { hashEntities } from "./hash";
import { seedRng, rngRange, getRngState, setRngState } from "./rng";
import { initPassability, getPassability, getMapW, getMapH } from "./passability";
import { initOccupancy, resetOccupancy, occupyRect, freeRect, rectEmpty } from "./occupancy";
import { initWalkGrid, resetWalkGrid, reserveUnit, freeUnit, footprintSoftFreeAt } from "./walkGrid";
import { initPathObstacles, markIdleDirty, isIdleDirty, clearIdleDirty, resetIdleGrids, addIdleCSpace } from "./pathObstacles";
import { initLocalPath } from "./localPath";
import { getOrComputeFlowField, clearFlowFieldCache, UNREACHABLE } from "./flowField";
import { inRange, distance } from "./distance";
import { initVision, visionSystem, getBelievedPassability, exportExplored, importExplored, FOW_SIGHT_TILES } from "./vision";

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
    const team = Unit.team[eid];
    const pass = getBelievedPassability(team);   // fog-aware (matches setMoveTarget)
    const mapW = getMapW();

    let goalTx   = fpToTile(txFP);
    let goalTy   = fpToTile(tyFP);
    const curTx  = Path.curTx[eid];
    const curTy  = Path.curTy[eid];

    if (curTx === goalTx && curTy === goalTy) return;

    let dir: number;
    if (pass) {
        if (pass[goalTy * mapW + goalTx]) {
            // Blocked terrain — preview toward the nearest walkable tile (matches
            // setMoveTarget so the instant facing agrees with where it'll go).
            const near = nearestPassableTile(team, goalTx, goalTy);
            if (!near) return;
            [goalTx, goalTy] = near;
            if (curTx === goalTx && curTy === goalTy) return;
        }
        const ff = getOrComputeFlowField(team, goalTx, goalTy);
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

/**
 * Passable tile nearest to (tx,ty).  When a move is ordered onto blocked terrain
 * (right-clicking a tree, water, a cliff…), units should still gather as close to
 * the click as possible rather than ignore the order — so the goal is snapped to
 * the closest walkable tile.
 *
 * Deterministic (safe in the authoritative sim): expands in Chebyshev rings of
 * increasing radius and, within a ring, picks the candidate with the smallest
 * integer dodecagon distance to the click, breaking ties by scan order.  Returns
 * the tile itself if it is already passable, or null if the map has none.
 */
function nearestPassableTile(team: number, tx: number, ty: number): [number, number] | null {
    const pass = getBelievedPassability(team);   // fog-aware: unexplored counts as passable
    const mapW = getMapW();
    const mapH = getMapH();
    if (!pass) return [tx, ty];
    const inBounds = (x: number, y: number) => x >= 0 && x < mapW && y >= 0 && y < mapH;
    if (inBounds(tx, ty) && !pass[ty * mapW + tx]) return [tx, ty];

    const maxR = Math.max(mapW, mapH);
    for (let r = 1; r <= maxR; r++) {
        let best: [number, number] | null = null;
        let bestD = Infinity;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;  // ring edge only
                const x = tx + dx, y = ty + dy;
                if (!inBounds(x, y) || pass[y * mapW + x]) continue;        // off-map / blocked
                const d = distance(dx, dy);
                if (d < bestD) { bestD = d; best = [x, y]; }
            }
        }
        if (best) return best;
    }
    return null;
}

/** Authoritative halt — clears movement/path/anim state (occupancy unchanged). */
export function stopUnit(_world: SimWorld, eid: number): void {
    _stopUnit(eid);
}

/**
 * Issue a move order. Returns whether an order was actually applied: `false` means
 * the unit got no order (no reachable passable tile near the goal, or — when
 * `snapBlocked` is false — the requested tile is itself blocked).
 *
 * `snapBlocked` (default true): if the goal tile is impassable, retarget the nearest
 * walkable tile.  A formation move passes `false` for the per-unit slot so a blocked
 * slot is *rejected* (caller collapses that unit onto the shared destination) instead
 * of scatter-snapping it to some random nearby pocket and shredding the formation.
 *
 * `flowTxOpt`/`flowTyOpt` (default -1 = unset): the SHARED flow-field goal tile for a group move — the
 * group's common destination, so all N units read ONE cached field (one Dijkstra) for long-range
 * navigation while each still targets its own slot point (txFP/tyFP) for the local approach + settle.
 * Unset → the flow goal IS this unit's slot tile (a standalone move navigates straight to its target).
 */
export function setMoveTarget(
    _world: SimWorld, eid: number, txFP: number, tyFP: number,
    snapBlocked = true, avoidUnits = false,
    flowTxOpt = -1, flowTyOpt = -1,
): boolean {
    const team = Unit.team[eid];
    markIdleDirty();   // this unit is (un)settling → its tile leaves/joins the path-obstacle set
    const pass = getBelievedPassability(team);   // fog-aware: may path into assumed-passable fog
    const mapW = getMapW();

    if (!pass) {
        // No map loaded — direct movement fallback (pre-map mode)
        MoveTarget.tx[eid]     = txFP;
        MoveTarget.ty[eid]     = tyFP;
        MoveTarget.active[eid] = 1;
        Path.active[eid]       = 0;
        Path.stuckTicks[eid]   = 0;
        return true;
    }

    // Rest on the 8px collision grid (snapWalkFP), not the 32px tile centre — so a unit can anchor
    // at a sub-tile position while still landing grid-clean (a 32px box on the 8px grid = 4 whole
    // cells).  The goal *tile* (for the flow field + passability) is derived from the snapped point.
    let goalXFP = snapWalkFP(txFP);
    let goalYFP = snapWalkFP(tyFP);
    let goalTx  = fpToTile(goalXFP);
    let goalTy  = fpToTile(goalYFP);

    if (pass[goalTy * mapW + goalTx]) {
        // Blocked terrain (tree/water/cliff). For a formation slot, reject so the caller can fall
        // back to the group destination; otherwise aim for the nearest passable tile *centre*.
        if (!snapBlocked) return false;
        const near = nearestPassableTile(team, goalTx, goalTy);
        if (!near) return false;
        [goalTx, goalTy] = near;
        goalXFP = tileCenterFP(goalTx);
        goalYFP = tileCenterFP(goalTy);
    }

    // Correct the destination off any *settled* unit sitting on it (avoidUnits = a standalone move; group
    // moves spread via the formation/gather slot logic instead).  Rather than letting the unit walk onto
    // an occupied tile and resolve the overlap at settle (which dwells then pops), retarget the nearest
    // tile whose footprint is clear up front, so it paths to a clean rest spot.  Ignores *moving* units
    // (they clear) — only parked units relocate the goal.
    if (avoidUnits) {
        const rad = unitRadiusPx(Unit.type[eid]) * FP;
        if (!footprintSoftFreeAt(goalXFP, goalYFP, rad, eid)) {
            const STEP = TILE_PX * FP;
            const mapH = getMapH();
            search:
            for (let r = 1; r <= 6; r++) {
                for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    const fx = goalXFP + dx * STEP, fy = goalYFP + dy * STEP;
                    const tx = fpToTile(fx), ty = fpToTile(fy);
                    if (tx < 0 || ty < 0 || tx >= mapW || ty >= mapH) continue;
                    if (pass[ty * mapW + tx]) continue;                        // blocked terrain
                    if (footprintSoftFreeAt(fx, fy, rad, eid)) {
                        goalXFP = fx; goalYFP = fy; goalTx = tx; goalTy = ty;
                        break search;
                    }
                }
            }
        }
    }

    // Flow-field goal: the SHARED group destination (one cached field for the whole group), distinct from
    // this unit's own slot tile (goalTx/goalTy) which the local layer peels it onto at the end.  A
    // standalone move passes no flow goal → it navigates straight to its own slot tile as before.  Snap a
    // blocked shared goal (e.g. the click landed on a tree) to the nearest passable tile so the field is
    // computable; fall back to the slot tile if there's no passable tile near the shared goal.
    let flowTx = flowTxOpt, flowTy = flowTyOpt;
    if (flowTx < 0 || flowTy < 0) { flowTx = goalTx; flowTy = goalTy; }
    else if (pass[flowTy * mapW + flowTx]) {
        const nf = nearestPassableTile(team, flowTx, flowTy);
        if (nf) [flowTx, flowTy] = nf; else { flowTx = goalTx; flowTy = goalTy; }
    }

    const curTx = fpToTile(Position.x[eid]);
    const curTy = fpToTile(Position.y[eid]);

    // Record the unit's SLOT point (its final target) and the SHARED flow goal that steers it there.
    // Path.goalTx/goalTy is the flow-field key (shared across the group); the slot tile is derived from
    // MoveTarget.tx/ty by the movement system for its near-goal handoff.
    Path.goalTx[eid]       = flowTx;
    Path.goalTy[eid]       = flowTy;
    MoveTarget.tx[eid]     = goalXFP;
    MoveTarget.ty[eid]     = goalYFP;
    Path.stuckTicks[eid]   = 0;

    if (curTx === goalTx && curTy === goalTy) {
        // Already standing in the slot tile — just nudge toward the exact point (no flow needed).
        MoveTarget.active[eid] = 1;
        Path.active[eid]       = 1;
        return true;
    }

    // Pre-warm the shared flow field (all N units of a group share ONE goal → one Dijkstra) and skip the
    // order if this unit can't reach the shared destination at all.
    const ff = getOrComputeFlowField(team, flowTx, flowTy);
    if (!ff) return false;
    if (ff.dirs[curTy * mapW + curTx] === UNREACHABLE) return false;

    MoveTarget.active[eid] = 1;
    Path.active[eid]       = 1;
    return true;
}

/**
 * Tiles currently held by a SETTLED unit *outside* `group` — seeded into a formation's `claimed`
 * reservation set so a slot never lands on a parked unit.  Without this a slot is chosen on terrain
 * alone; the unit then walks onto the occupied tile and `settleOnto`'s ring-search relocates it at the
 * final tick — the "unit zooms into a different space" teleport.  Group members and still-moving units
 * are excluded (they'll vacate their tile), as are buildings (already static terrain via passability).
 * Deterministic: a pure scan of Position/MoveTarget in eid order.
 */
function occupiedTilesOutside(world: SimWorld, group: number[], mapW: number): Set<number> {
    const inGroup = new Set(group);
    const taken = new Set<number>();
    for (const e of unitEids(world)) {
        if (inGroup.has(e) || MoveTarget.active[e] === 1 || Building.fw[e] > 0) continue;
        taken.add(fpToTile(Position.y[e]) * mapW + fpToTile(Position.x[e]));
    }
    return taken;
}

/**
 * Greedily map a set of units onto a set of slot centres and issue the moves.  Slots are filled in
 * an order chosen by `fill`, each going to its nearest still-unassigned unit:
 *   "far"  — furthest slot from the group first.  A *translating* formation thus has its leading
 *            edge claim the deepest slots, so the block unrolls into place without units crossing.
 *   "near" — nearest slot first.  A *converging* cluster barely shuffles (minimal total travel).
 * Surplus units (more units than slots) fall back to the click point; an unreachable slot too.
 * Deterministic: distance sort + nearest-unit pick are pure, with eid tie-breaks.
 */
function assignUnitsToSlots(
    world: SimWorld, eids: number[], slots: Array<[number, number]>,
    fill: "far" | "near", txFP: number, tyFP: number,
): void {
    let gcx = 0, gcy = 0;
    for (const e of eids) { gcx += Position.x[e]; gcy += Position.y[e]; }
    gcx = (gcx / eids.length) | 0; gcy = (gcy / eids.length) | 0;

    // Sub-tile anchor: the slots are tile-centred, but shift the whole block by how far the click sat
    // from its own tile centre (snapped to the 8px grid, clamped to ±8px so each unit stays in its
    // passable slot tile).  This anchors the formation where you clicked, not on the 32px lattice.
    const cap = WALK_PX * FP;
    const clamp = (v: number) => v < -cap ? -cap : v > cap ? cap : v;
    const shiftX = clamp(snapWalkFP(txFP) - tileCenterFP(fpToTile(txFP)));
    const shiftY = clamp(snapWalkFP(tyFP) - tileCenterFP(fpToTile(tyFP)));

    const sign = fill === "far" ? -1 : 1;   // "far" → descending distance from the group centroid
    const order = slots.map((_, i) => i).sort((a, b) =>
        sign * (distance(slots[a][0] - gcx, slots[a][1] - gcy) - distance(slots[b][0] - gcx, slots[b][1] - gcy)) || (a - b));

    // One SHARED flow-field goal for the whole group (the click destination tile): every unit reads the
    // same cached field for long-range navigation (one Dijkstra, not one-per-slot) and peels onto its own
    // slot via the local layer near the end.  setMoveTarget snaps it to passable if the click was blocked.
    const flowTx = fpToTile(txFP), flowTy = fpToTile(tyFP);

    const remaining = [...eids];
    const n = Math.min(eids.length, slots.length);
    for (let k = 0; k < n; k++) {
        const sx = slots[order[k]][0] + shiftX, sy = slots[order[k]][1] + shiftY;
        let bi = 0, bd = Infinity;                                  // nearest unassigned unit to this slot
        for (let i = 0; i < remaining.length; i++) {
            const e = remaining[i];
            const d = distance(Position.x[e] - sx, Position.y[e] - sy);
            if (d < bd || (d === bd && e < remaining[bi])) { bd = d; bi = i; }
        }
        const e = remaining.splice(bi, 1)[0];
        if (!setMoveTarget(world, e, sx, sy, true, false, flowTx, flowTy))
            setMoveTarget(world, e, txFP, tyFP, true, false, flowTx, flowTy);
    }
    for (const e of remaining)                                      // more units than slots → centre
        setMoveTarget(world, e, txFP, tyFP, true, false, flowTx, flowTy);
}

/**
 * Hold formation while keeping every unit on passable, *distinct* ground.  The slot block is the
 * group's arrangement (each unit's centroid offset) translated to the click point — an axis-aligned
 * translation, so the shape is preserved.  A slot on impassable terrain (or colliding with another)
 * reflows outward to the nearest free passable tile, so the block deforms *locally* around the
 * obstacle instead of collapsing onto the click point.  Units are then assigned furthest-slot-first
 * so a translating formation unrolls into place without crossing (see assignUnitsToSlots).
 *
 * Deterministic: centroid, passability and the spiral search are pure functions of shared state,
 * built in eid order (claims are order-dependent but reproduced by replay).
 */
export function setFormationTargets(world: SimWorld, eids: number[], txFP: number, tyFP: number): void {
    const team = Unit.team[eids[0]];
    const pass = getBelievedPassability(team);
    const mapW = getMapW(), mapH = getMapH();
    if (!pass) { for (const e of eids) setMoveTarget(world, e, txFP, tyFP); return; }

    const passable = (x: number, y: number) =>
        x >= 0 && x < mapW && y >= 0 && y < mapH && !pass[y * mapW + x];

    let sx = 0, sy = 0;
    for (const e of eids) { sx += Position.x[e]; sy += Position.y[e]; }
    const cx = (sx / eids.length) | 0, cy = (sy / eids.length) | 0;

    // Build the formation slots: each unit's offset tile, reflowed to the nearest free passable tile.
    // Seed `claimed` with tiles held by settled non-group units so a slot never targets a parked unit
    // (which would walk the unit there then teleport it off at settle — see occupiedTilesOutside).
    const claimed = occupiedTilesOutside(world, eids, mapW);
    const slots: Array<[number, number]> = [];
    const maxR = Math.max(mapW, mapH);
    for (const e of eids) {
        const dtx = fpToTile(txFP + (Position.x[e] - cx));
        const dty = fpToTile(tyFP + (Position.y[e] - cy));
        for (let r = 0; r <= maxR; r++) {
            let placed = false;
            for (let dy = -r; dy <= r && !placed; dy++) for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;       // ring edge only
                const gx = dtx + dx, gy = dty + dy, key = gy * mapW + gx;
                if (passable(gx, gy) && !claimed.has(key)) {
                    claimed.add(key); slots.push([tileCenterFP(gx), tileCenterFP(gy)]); placed = true; break;
                }
            }
            if (placed) break;
        }
    }
    if (slots.length === 0) { for (const e of eids) setMoveTarget(world, e, txFP, tyFP); return; }

    assignUnitsToSlots(world, eids, slots, "far", txFP, tyFP);
}

/**
 * Gather a group tightly around a point: each unit is given its own tile-centred slot in a
 * compact spiral of passable tiles around the destination, so the selection packs into a
 * neat grid-aligned block instead of all piling onto the exact click point.  Slots are one
 * tile apart, which matches a 32px unit box, so they settle cleanly without fighting the
 * walk-grid reservation.
 *
 * Slots are filled nearest-first (assignUnitsToSlots "near"): each unit takes the closest slot, so
 * a converging cluster barely shuffles — minimal travel, minimal jostling, a tidy block.
 *
 * Used for "converge" moves (re-click the same spot, or a too-scattered selection) — see
 * systems/commands.ts.  Deterministic: spiral order, passability and the nearest-first assignment
 * (eid tie-breaks) are all pure functions of shared state.
 */
export function setGatherTargets(world: SimWorld, eids: number[], txFP: number, tyFP: number): void {
    const team = Unit.team[eids[0]];
    const pass = getBelievedPassability(team);
    const mapW = getMapW(), mapH = getMapH();
    if (!pass) { for (const e of eids) setMoveTarget(world, e, txFP, tyFP); return; }

    const inBounds = (x: number, y: number) => x >= 0 && x < mapW && y >= 0 && y < mapH;
    const passable = (x: number, y: number) => inBounds(x, y) && !pass[y * mapW + x];
    // A slot tile is free only if it's passable AND not held by a settled non-group unit (so the block
    // packs around parked units instead of targeting their tile and teleporting off at settle).
    const taken = occupiedTilesOutside(world, eids, mapW);
    const free = (x: number, y: number) => passable(x, y) && !taken.has(y * mapW + x);

    // Centre the cluster on passable ground.
    let ctx = fpToTile(txFP), cty = fpToTile(tyFP);
    if (!passable(ctx, cty)) {
        const near = nearestPassableTile(team, ctx, cty);
        if (near) [ctx, cty] = near;
    }

    // Slot block, near-square so the group packs into a tidy rectangle (4 → 2×2, 9 → 3×3)
    // rather than a spread line.  Fill the rectangle's passable tiles first, then — if blocked
    // terrain left us short — expand outward ring by ring to make up the count.
    const count = eids.length;
    const cols  = Math.round(Math.sqrt(count)) || 1;
    const rows  = Math.ceil(count / cols);
    const left = ctx - ((cols - 1) >> 1), top = cty - ((rows - 1) >> 1);
    const inRect = (x: number, y: number) => x >= left && x < left + cols && y >= top && y < top + rows;

    const scx: number[] = [], scy: number[] = [];   // slot centres (fixed-point)
    for (let ry = 0; ry < rows; ry++) for (let rx = 0; rx < cols; rx++) {
        if (free(left + rx, top + ry)) { scx.push(tileCenterFP(left + rx)); scy.push(tileCenterFP(top + ry)); }
    }
    const maxR = Math.max(mapW, mapH);
    for (let r = 1; r <= maxR && scx.length < count; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;     // ring edge only
                if (inRect(ctx + dx, cty + dy)) continue;                      // already considered
                if (free(ctx + dx, cty + dy)) { scx.push(tileCenterFP(ctx + dx)); scy.push(tileCenterFP(cty + dy)); }
            }
        }
    }
    if (scx.length === 0) { for (const e of eids) setMoveTarget(world, e, txFP, tyFP); return; }

    // Converging in place → fill the NEAREST slot first, so units barely shuffle (minimal travel).
    assignUnitsToSlots(world, eids, scx.map((cx, i) => [cx, scy[i]]), "near", txFP, tyFP);
}

// ── Visibility ────────────────────────────────────────────────────────────────

/**
 * Returns the set of stable UnitIds visible to observerTeam.
 * Own units are always included; an enemy unit is included if it lies within the
 * *observing* unit's own sight radius (per-unit, unitSight; dodecagonal metric).
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
            if (inRange(Path.curTx[m] - etx, Path.curTy[m] - ety, unitSight(Unit.type[m]))) {
                visible.add(UnitId.id[e]);
                break;
            }
        }
    }
    return visible;
}

/** True if tile (tx, ty) is within sight of any unit owned by observerTeam
 *  (each unit using its own unitSight radius). */
export function isTileVisible(world: SimWorld, observerTeam: number, tx: number, ty: number): boolean {
    for (const e of unitEids(world)) {
        if (Unit.team[e] !== observerTeam) continue;
        if (inRange(Path.curTx[e] - tx, Path.curTy[e] - ty, unitSight(Unit.type[e]))) return true;
    }
    return false;
}

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
        stuckTicks: Path.stuckTicks[eid],
        dir:        UnitAnim.dir[eid],
        moving:     UnitAnim.moving[eid],
        bw:         Building.fw[eid],
        bh:         Building.fh[eid],
        buildLeft:  Building.buildLeft[eid],
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
    _unitIdToEid.set(snap.uid, eid);
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
    if (Building.fw[eid] > 0) freeRect(Path.curTx[eid], Path.curTy[eid], Building.fw[eid], Building.fh[eid]);
    else                      freeUnit(eid);
    _unitIdToEid.delete(UnitId.id[eid]);
    removeEntity(world, eid);
}

/** Create a predicted own unit from a snapshot (simulated; guest prediction). */
export function addOwnUnit(world: SimWorld, snap: UnitSnapshot): void { _spawnFromSnapshot(world, snap, false); }
/** Snap a diverged predicted own unit back to its authoritative snapshot. */
export function reconcileOwnUnit(eid: number, snap: UnitSnapshot): void { _applyFromSnapshot(eid, snap, false); }

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
}

export function takeSnapshot(world: SimWorld): WorldSnapshot {
    return {
        tick:       world.tick,
        nextUnitId: _nextUnitId,
        rngState:   getRngState(),
        units:      unitEids(world).map(snapshotUnit),
        explored:   exportExplored(),
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
        _unitIdToEid.set(u.uid, eid);
    }

    // Restore explored terrain (and rebuild believedPass) for fog-aware pathing.
    importExplored(snap.explored ?? []);
}
