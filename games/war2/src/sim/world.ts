/**
 * The sim world — an instance: everything the sim knows lives on it (its components, terrain, grids, caches, RNG, id
 * registry, per-team vision), so any number of worlds run side by side in one realm without touching each other — a
 * referee and its clients' predictions in one test process, say. Nothing in the sim keeps state of its own between
 * calls; every function that reads or writes some takes the world.
 */
import type { Components, SimFields } from "./components.ts";
import type { FlowFields } from "./flowField.ts";
import type { LocalPathScratch } from "./localPath.ts";
import type { Terrain } from "./passability.ts";
import type { PathObstacles } from "./pathObstacles.ts";
import type { Order, ProductionState } from "./types.ts";
import type { TeamVision } from "./vision.ts";
import type { WalkGrid } from "./walkGrid.ts";
import { addComponent, addEntity, createWorld, hasComponent, observe, onAdd, onRemove, query, removeEntity } from "bitecs";
import { createComponents, FP, fpToTile, MAX_ENTITIES, resetEntity, simFields, TILE_PX, WORLD_H, WORLD_W } from "./components.ts";
import { clearFlowFieldCache, createFlowFields } from "./flowField.ts";
import { createLocalPath } from "./localPath.ts";
import { freeRect, occupyRect, rectEmpty } from "./occupancy.ts";
import { advanceOrderQueues } from "./orders.ts";
import { buildTerrain } from "./passability.ts";
import { addIdleCSpace, createPathObstacles, markIdleDirty, resetIdleGrids } from "./pathObstacles.ts";
import { productionSystem } from "./production.ts";
import { rngRange, rngState } from "./rng.ts";
import { movementSystem } from "./systems/movement.ts";
import { unitBuildTicks, unitFootprint, unitRadiusPx } from "./unitTypes.ts";
import { createVision, visionSystem } from "./vision.ts";
import { createWalkGrid, freeUnit, reserveUnit, resetWalkGrid } from "./walkGrid.ts";

export type { UnitSnapshot } from "./types.ts";

export interface SimWorld {
	/** Its components (bitecs 0.4: plain objects, registered with this world as entities gain them). */
	"components": Components;
	/** Its sim fields (components.ts simFields): what snapshots, spawn resets and the hash enumerate. */
	"fields": SimFields;
	/** The xorshift state (rng.ts). */
	"rng": number;
	/** The next stable unit id to hand out, and each live entity by its stable id. */
	"nextUnitId": number;
	"eidOf": Map<number, number>;
	/** The map: size, and passability (null pass without one — pre-map dev mode). */
	"terrain": Terrain;
	/** Which building holds each tile (occupancy.ts); null without a map. */
	"occupancy": Int32Array | null;
	/** The 8px unit-collision broad phase (walkGrid.ts); null without a map. */
	"walk": WalkGrid | null;
	/** Each team's settled-unit C-space for the local A* (pathObstacles.ts). */
	"obstacles": PathObstacles;
	/** The local A*'s scratch (localPath.ts); null without a map. */
	"local": LocalPathScratch | null;
	/** Flow fields: the cache and the Dijkstra's scratch (flowField.ts). */
	"flow": FlowFields;
	/** Each team's explored map and believed passability (vision.ts). */
	"vision": Map<number, TeamVision>;
	/** Whether stepping explores from its units' sight (visionSystem). A client's prediction doesn't: what its team has
	 *  explored comes from the referee (exploreTiles), so its pathing believes exactly what authority's does. */
	"exploring": boolean;
	"tick": number;
    /** Last MOVE per team — target tile + a signature of the selected unit set.  A repeat
     *  click by the *same* selection on the *same* tile converges the group on the point
     *  instead of holding formation (see systems/commands.ts).  Keying on the selection
     *  lets a player cycle control groups onto one spot, each getting its own first-click
     *  formation. */
	"lastMove"?: Record<number, { "tileX": number; "tileY": number; "sig": number }>;
    /** Active gather target block per team (slot centres, fixed-point).  Set by a converge
     *  move; a settling unit of this team claims the nearest still-free slot so the block
     *  fills in contiguously with no holes (see systems/movement.ts).  Cleared by any
     *  non-converge move for the team. */
	"gatherSlots"?: Record<number, [number, number][]>;
    /** Per-unit action queue, keyed by stable UnitId (survives eid recycling / resync).  Shift-queued
     *  orders wait here; advanceOrderQueues (game/orders.ts) pops the head when the unit settles. */
	"orders"?: Record<number, Order[]>;
    /** Per-building production queue, keyed by stable UnitId.  productionSystem (game/production.ts)
     *  counts down the head item and spawns the trained unit. */
	"production"?: Record<number, ProductionState>;
    /** Per-building rally point (fixed-point), keyed by stable UnitId.  Freshly trained units get a
     *  move order toward it. */
	"rally"?: Record<number, { "txFP": number; "tyFP": number }>;
}

// ── Observers (bitecs 0.4) ────────────────────────────────────────────────────
// Use onAdd/onRemove to react to unit lifecycle rather than polling.
// Other systems (renderer, net) can call registerObservers() after world creation.

export interface UnitLifecycle {
	"onSpawn"?: (eid: number) => void;
	"onDespawn"?: (eid: number) => void;
}

export function registerObservers(world: SimWorld, hooks: UnitLifecycle): void {
	const { MoveTarget, Position, Unit } = world.components;

	if (hooks.onSpawn) { observe(world, onAdd(Position, Unit, MoveTarget), hooks.onSpawn); }
	if (hooks.onDespawn) { observe(world, onRemove(Position, Unit, MoveTarget), hooks.onDespawn); }
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
// Call initUnitIdCounter(world, myTeam) once per peer before spawning any units.

/** Initialise the counter for the local team (call exactly once at game start). */
export function initUnitIdCounter(world: SimWorld, team: number): void {
	world.nextUnitId = team === 0 ? 1 : 0x80000001;
}

/** Take the next available unit ID for this peer's team. */
export function consumeUnitId(world: SimWorld): number {
	const id = world.nextUnitId;

	world.nextUnitId += 1;

	return id;
}

/**
 * Advance the counter if a received ID is ahead of us and in our ID space.
 * (Called when we learn about a new own-team unit — e.g. from a snapshot replay.)
 */
export function setNextUnitId(world: SimWorld, n: number): void {
	const myHighBit = world.nextUnitId >= 0x80000000;
	const nHighBit = n >= 0x80000000;

	if (myHighBit === nHighBit && n >= world.nextUnitId) { world.nextUnitId = n + 1; }
}

/** Returns the local bitecs eid for a given stable unit ID, or undefined. */
export function eidForUnitId(world: SimWorld, uid: number): number | undefined { return world.eidOf.get(uid); }

// ── World factory ─────────────────────────────────────────────────────────────

export interface MapInfo {
	"gids": number[];   // flat tile GID array from the map's tile layer
	"mapW": number;
	"mapH": number;
	"terrainArr": number[];   // terrain.json[tilesetName], indexed by GID
}

/** A world for `teams` teams (each keeps its own vision) on `mapInfo`'s map — or none (pre-map dev mode). */
export function createSimWorld(seed: number, mapInfo?: MapInfo, teams = 2): SimWorld {
	const components = createComponents();
	const { mapW = 0, mapH = 0 } = mapInfo ?? {};

	return createWorld<SimWorld>({
		"components": components,
		"fields": simFields(components),
		"rng": rngState(seed),
		"nextUnitId": 1,
		"eidOf": new Map(),
		"terrain": mapInfo ? buildTerrain(mapInfo.gids, mapW, mapH, mapInfo.terrainArr) : { "w": 0, "h": 0, "pass": null },
		"occupancy": mapInfo ? new Int32Array(mapW * mapH) : null,
		"walk": mapInfo ? createWalkGrid(mapW, mapH) : null,          // 8px unit-collision reservation grid
		"obstacles": createPathObstacles(mapW, mapH),                 // per-team settled-unit grid for pathing
		"local": mapInfo ? createLocalPath(mapW, mapH) : null,        // scratch for the short-range unit-aware A*
		"flow": createFlowFields(),
		// Per-team vision for every team (each paths on its own knowledge).
		"vision": mapInfo ? createVision(mapW, mapH, [...Array.from({ "length": teams }).keys()]) : new Map(),
		"exploring": true,
		"tick": 0
	});
}

// ── Entity helpers ────────────────────────────────────────────────────────────

/** True if the world has room for one more entity (see MAX_ENTITIES). Every spawn checks it, and spawns nothing past
 *  it: the commands' validator caps each team well below, so this is the last line, not the rule. */
export function hasRoom(world: SimWorld): boolean {
	return world.eidOf.size < MAX_ENTITIES;
}

/**
 * Spawn a unit with an explicit stable unitId (use when applying a received
 * SPAWN command) or let the counter auto-assign one (initial world setup).
 * Returns the entity, or -1 if the world is full (hasRoom).
 */
export function spawnUnit(world: SimWorld, xFP: number, yFP: number, team: number, unitId?: number, typeId = 0): number {
	if (!hasRoom(world)) {
		return -1;
	}

	const { Building, MoveTarget, Path, Position, Unit, UnitAnim, UnitId } = world.components;
	const uid = unitId !== undefined ? unitId : consumeUnitId(world);
	const eid = addEntity(world);

	resetEntity(world.fields, eid);   // bitecs recycles eids: start from nothing (corridor, goal, footprint…)
	addComponent(world, eid, Position);
	addComponent(world, eid, MoveTarget);
	addComponent(world, eid, Unit);
	addComponent(world, eid, UnitId);
	Position.x[eid] = xFP;
	Position.y[eid] = yFP;
	MoveTarget.active[eid] = 0;
	Unit.team[eid] = team;
	Unit.selected[eid] = 0;
	Unit.movable[eid] = 1;   // locally simulated
	Unit.type[eid] = typeId;
	UnitId.id[eid] = uid;
	Path.active[eid] = 0;
	Path.stuckTicks[eid] = 0;
	Path.curTx[eid] = fpToTile(xFP);   // current tile (recomputed each move tick)
	Path.curTy[eid] = fpToTile(yFP);
	UnitAnim.dir[eid] = 4;   // default South
	UnitAnim.moving[eid] = 0;
    // Clear any stale Building fields: bitecs recycles eids, so an eid that previously held a building would
    // otherwise leave fw/fh set — making this unit render as a building (the blue fallback rect) and get skipped
    // by the movement system (Building.fw > 0 guard). (resetEntity already did; kept for the reader.)
	Building.fw[eid] = 0; Building.fh[eid] = 0; Building.buildLeft[eid] = 0;
	if (world.walk) { reserveUnit(world, eid); }   // claim the unit's footprint on the 8px collision grid
	markIdleDirty(world);         // a new idle unit joins the path-obstacle set
	world.eidOf.set(uid, eid);
	if (unitId !== undefined) { setNextUnitId(world, unitId); } // keep counter ahead

	return eid;
}

export function despawnUnit(world: SimWorld, eid: number): void {
	const { Building, Path, UnitId } = world.components;

	if (hasComponent(world, eid, Building)) {
		freeRect(world, Path.curTx[eid], Path.curTy[eid], Building.fw[eid], Building.fh[eid]);
		clearFlowFieldCache(world);   // footprint freed → cached fields routed around it are stale
	} else if (world.walk) {
		freeUnit(world, eid);    // release the unit's footprint on the collision grid
	}

	Path.active[eid] = 0;
	markIdleDirty(world);        // a unit left the path-obstacle set
	const uid = UnitId.id[eid];

	world.eidOf.delete(uid);
    // Drop any queue state this uid held (action queue, production, rally) so a recycled uid starts clean.
	if (world.orders) { delete world.orders[uid]; }
	if (world.production) { delete world.production[uid]; }
	if (world.rally) { delete world.rally[uid]; }
	removeEntity(world, eid);
}

/** True if a building of the given type fits at footprint top-left (tileX,tileY):
 *  every footprint tile in-bounds, passable terrain, and unoccupied. */
export function canPlaceBuilding(world: SimWorld, tileX: number, tileY: number, typeId: number): boolean {
	const [fw, fh] = unitFootprint(typeId);
	const { pass, w: mapW } = world.terrain;

	if (pass) {
		for (let y = 0; y < fh; y++) {
			for (let x = 0; x < fw; x++) { if (pass[(tileY + y) * mapW + (tileX + x)]) { return false; } }
		} // terrain-blocked
	}

	return rectEmpty(world, tileX, tileY, fw, fh);
}

/** Spawn a building entity occupying its footprint, with construction in progress.
 *  Shares the unit pool (Position/Unit/UnitId + inert MoveTarget/Path/UnitAnim). Returns -1 if the world is full. */
export function spawnBuilding(world: SimWorld, tileX: number, tileY: number, team: number, typeId: number, unitId?: number): number {
	if (!hasRoom(world)) {
		return -1;
	}

	const { Building, MoveTarget, Path, Position, Unit, UnitAnim, UnitId } = world.components;
	const uid = unitId !== undefined ? unitId : consumeUnitId(world);
	const [fw, fh] = unitFootprint(typeId);
	const eid = addEntity(world);

	resetEntity(world.fields, eid);   // bitecs recycles eids: start from nothing (corridor, goal, footprint…)
	addComponent(world, eid, Position);
	addComponent(world, eid, MoveTarget);
	addComponent(world, eid, Unit);
	addComponent(world, eid, UnitId);
	addComponent(world, eid, Building);
	Position.x[eid] = tileX * TILE_PX * FP + ((fw * TILE_PX) >> 1) * FP;
	Position.y[eid] = tileY * TILE_PX * FP + ((fh * TILE_PX) >> 1) * FP;
	MoveTarget.active[eid] = 0;
	Unit.team[eid] = team;
	Unit.selected[eid] = 0;
	Unit.movable[eid] = 0;   // buildings never move (also excluded by Building.fw guard)
	Unit.type[eid] = typeId;
	UnitId.id[eid] = uid;
	Path.active[eid] = 0;
	Path.curTx[eid] = tileX;   // footprint top-left — anchors occupancy restore
	Path.curTy[eid] = tileY;
	UnitAnim.dir[eid] = 4;
	UnitAnim.moving[eid] = 0;
	Building.fw[eid] = fw;
	Building.fh[eid] = fh;
	Building.buildLeft[eid] = unitBuildTicks(typeId);
	occupyRect(world, tileX, tileY, fw, fh, eid);
	clearFlowFieldCache(world);   // new footprint → units must route around it now
	world.eidOf.set(uid, eid);
	if (unitId !== undefined) { setNextUnitId(world, unitId); }

	return eid;
}

export function spawnRandom(world: SimWorld, team: number): number {
	return spawnUnit(
		world,
		rngRange(world, 40 * FP, WORLD_W - 40 * FP),
		rngRange(world, 40 * FP, WORLD_H - 40 * FP),
		team
	);
}

/** Advance construction on all buildings (one tick of progress). */
function buildingSystem(world: SimWorld): void {
	const { Building } = world.components;

	for (const eid of query(world, [Building])) {
		if (Building.buildLeft[eid] > 0) { Building.buildLeft[eid] -= 1; }
	}
}

/**
 * Rebuild the per-team settled-unit obstacle grid (read by the short-range local A*, localPath.ts)
 * when the idle set has changed.  Cheap no-op when nothing settled/moved since the last call.  This
 * deliberately does NOT touch the flow-field cache — the flow field is terrain-only, so units never
 * invalidate it (that separation is what keeps pathing cheap under combat churn).
 */
export function refreshPathObstacles(world: SimWorld): void {
	if (!world.obstacles.dirty) { return; }
	resetIdleGrids(world);
	const { Building, MoveTarget, Position, Unit } = world.components;
	const MOVER_R = TILE_PX >> 1;   // assume a ~tile mover for the shared C-space (land units)

	for (const eid of unitEids(world)) {
		if (hasComponent(world, eid, Building) || Unit.movable[eid] !== 1) { continue; }   // buildings / display-only
		if (MoveTarget.active[eid] === 1) { continue; }                       // moving → not an obstacle
        // 8px C-space: a mover's centre may not come within (mover r + this unit's r) of this centre.
		addIdleCSpace(world, Unit.team[eid], Position.x[eid] / FP, Position.y[eid] / FP, MOVER_R + unitRadiusPx(Unit.type[eid]));
	}

	world.obstacles.dirty = false;
}

/**
 * Repaint the 8px walk grid from where every unit is, in stable-id order. A cell holds one owner, and where units
 * overlap the last to paint it wins — so a grid kept up incrementally owns shared cells by who moved last, a history
 * no snapshot carries (a restored sim parted from the original within a tick). Repainted each tick, it's a function
 * of the state alone. Buildings hold tiles in the occupancy grid instead.
 */
function repaintWalkGrid(world: SimWorld): void {
	if (!world.walk) { return; }
	const { Building, UnitId } = world.components;

	resetWalkGrid(world);

	for (const eid of unitEids(world).filter((e) => !hasComponent(world, e, Building)).sort((a, b) => UnitId.id[a] - UnitId.id[b])) {
		reserveUnit(world, eid);
	}
}

export function stepWorld(world: SimWorld): void {
	repaintWalkGrid(world);        // the walk grid from positions alone — never from who moved last
	refreshPathObstacles(world);   // settled-unit obstacle grid current before movers path this tick
	movementSystem(world);
	advanceOrderQueues(world);     // settled units pick up their next shift-queued order
	buildingSystem(world);
	productionSystem(world);       // buildings advance their production queues (spawn + rally on complete)
	visionSystem(world);   // accumulate explored tiles from post-move LOS (deterministic)
	world.tick += 1;
}

/**
 * Every unit and building, in stable-id order — the order the order-sensitive systems walk them in (movement:
 * collision claims; production: who gets the next unit id), and snapshots list them in. Not bitecs's entity order,
 * which a snapshot restored into a running world (a live incident replay) gets in whatever order bitecs recycles ids:
 * a safeguard — no scenario's outcome has depended on it (the oracle's traces didn't move), but the sim shouldn't play
 * differently for where its entity ids came from.
 */
export function unitEids(world: SimWorld): number[] {
	const { MoveTarget, Position, Unit, UnitId } = world.components;

	return [...query(world, [Position, Unit, MoveTarget])].sort((a, b) => UnitId.id[a] - UnitId.id[b]);
}
