/**
 * Building production queues + rally points.
 *
 * A producing building (barracks, town hall, …) holds a FIFO of product unit typeIds on
 * `world.production[uid]` plus a countdown for the head item.  `productionSystem` (run each tick from
 * stepWorld) counts the head down and, on completion, spawns the trained unit on a free tile beside the
 * footprint — sending it to the rally point if one is set.  All state is keyed by stable UnitId so it
 * survives eid recycling and rides in snapshots (see snapshot.ts), keeping it deterministic for replay.
 *
 * Scope: only `trains` (spawnable units) for now; research/upgrades need an upgrade system and are
 * deferred.  No economy/cost accounting yet — a cancel just drops the queue item.
 */
import { query } from "bitecs";
import { Building, Unit, UnitId, Path, tileCenterFP } from "./components";
import { unitBuildTicks, unitTypeName } from "./unitTypes";
import { getPassability, getMapW, getMapH } from "./passability";
import { isEmpty } from "./occupancy";
import { enqueueOrder } from "./orders";
import { spawnUnit, type SimWorld } from "./world";
import productionJson from "../assets/production.json";
import type { ProductionState } from "./types";

const PRODUCTION = productionJson as Record<string, { trains?: string[] }>;

/** True if `buildingTypeId` can train `productTypeId` per production.json (deterministic shared data). */
export function buildingTrains(buildingTypeId: number, productTypeId: number): boolean {
    const trains = PRODUCTION[unitTypeName(buildingTypeId)]?.trains;
    return !!trains && trains.includes(unitTypeName(productTypeId));
}

/** A trained unit's build time, floored at 1 tick so the progress bar always has a span. */
function productTicks(productTypeId: number): number {
    return Math.max(1, unitBuildTicks(productTypeId));
}

/** Append a product to a building's production queue, seeding the head countdown if it was idle. */
export function enqueueProduction(world: SimWorld, buildingUid: number, productTypeId: number): void {
    const prod = (world.production ??= {});
    const p: ProductionState = prod[buildingUid] ??= { queue: [], ticksLeft: 0, ticksTotal: 0 };
    p.queue.push(productTypeId);
    if (p.queue.length === 1) { p.ticksTotal = productTicks(productTypeId); p.ticksLeft = p.ticksTotal; }
}

/** Remove the queued item at `index`.  Cancelling the head restarts the countdown for the new head. */
export function cancelProduction(world: SimWorld, buildingUid: number, index: number): void {
    const p = world.production?.[buildingUid];
    if (!p || index < 0 || index >= p.queue.length) return;
    p.queue.splice(index, 1);
    if (p.queue.length === 0) { delete world.production![buildingUid]; return; }
    if (index === 0) { p.ticksTotal = productTicks(p.queue[0]); p.ticksLeft = p.ticksTotal; }
}

/** Point a building's freshly trained units at a destination. */
export function setRally(world: SimWorld, buildingUid: number, txFP: number, tyFP: number): void {
    (world.rally ??= {})[buildingUid] = { txFP, tyFP };
}

/** Nearest passable, building-free tile in expanding rings around a building's footprint (or null). */
function freeSpawnTileAround(eid: number): [number, number] | null {
    const fx = Path.curTx[eid], fy = Path.curTy[eid];       // footprint top-left
    const fw = Building.fw[eid], fh = Building.fh[eid];
    const pass = getPassability();
    const mapW = getMapW(), mapH = getMapH();
    const free = (x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= mapW || y >= mapH) return false;
        if (pass && pass[y * mapW + x]) return false;        // blocked terrain
        return isEmpty(x, y);                                 // no building occupant (units resolve via collision)
    };
    for (let r = 1; r <= Math.max(mapW, mapH); r++) {
        const x0 = fx - r, y0 = fy - r, x1 = fx + fw - 1 + r, y1 = fy + fh - 1 + r;
        for (let x = x0; x <= x1; x++) { if (free(x, y0)) return [x, y0]; if (free(x, y1)) return [x, y1]; }
        for (let y = y0 + 1; y < y1; y++) { if (free(x0, y)) return [x0, y]; if (free(x1, y)) return [x1, y]; }
    }
    return null;
}

/** Advance every building's production queue one tick; spawn + rally completed units. */
export function productionSystem(world: SimWorld): void {
    if (!world.production) return;
    for (const eid of query(world, [Building])) {
        if (Building.buildLeft[eid] > 0) continue;            // still under construction → can't produce
        const uid = UnitId.id[eid];
        const p = world.production[uid];
        if (!p || p.queue.length === 0) continue;
        if (p.ticksLeft > 0) { p.ticksLeft--; continue; }

        const spot = freeSpawnTileAround(eid);
        if (!spot) continue;                                  // no room this tick — hold at 0, retry next tick
        const ueid = spawnUnit(world, tileCenterFP(spot[0]), tileCenterFP(spot[1]), Unit.team[eid], undefined, p.queue[0]);
        const r = world.rally?.[uid];
        if (r) enqueueOrder(world, ueid, { kind: "move", txFP: r.txFP, tyFP: r.tyFP }, false);

        p.queue.shift();
        if (p.queue.length) { p.ticksTotal = productTicks(p.queue[0]); p.ticksLeft = p.ticksTotal; }
        else delete world.production[uid];
    }
}
