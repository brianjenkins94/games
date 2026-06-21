/**
 * Per-team vision + believed passability.
 *
 * Each team has its own persistent *explored* map and the *believed passability*
 * view that fog-aware pathfinding reads instead of the omniscient terrain map.  The
 * referee simulates both teams, so it keeps a set of these keyed by team — team A's
 * units must path on team A's knowledge only, never team B's.
 *
 * Determinism: explored is a pure function of a team's own-unit positions over time
 * (updated each sim step via visionSystem), so it reproduces exactly on replay; it
 * travels in the deterministic snapshot but never over the wire.
 *
 * Believed passability (what a team's pathfinder is *allowed* to know):
 *   believedPass[i] = explored[i] ? realPass[i] : 0   (0 = passable)
 * Unexplored tiles are assumed passable, so units path optimistically into fog and
 * re-route once line of sight reveals a real obstacle.  Sight radius exceeds the
 * per-tick step distance, so the obstacle is always revealed before contact.
 *
 * Module-singleton, mirroring passability.ts / occupancy.ts.
 */
import { query } from "bitecs";
import { Position, Unit, MoveTarget, Path } from "./components";
import { inRange } from "./distance";
import { getPassability } from "./passability";
import { unitSight } from "./unitTypes";
import type { SimWorld } from "./world";

/** Default/fallback sight radius in tiles (per-unit sight comes from unitSight()).
 *  Canonical source — re-exported by world.ts; the renderer keeps a matching copy. */
export const FOW_SIGHT_TILES = 4;

interface TeamVision {
    explored:     Uint8Array;   // 0 = unexplored, 1 = explored (persists)
    believedPass: Uint8Array;   // 0 = passable, 1 = blocked (only where explored)
    dirty:        boolean;      // newly-explored terrain proved blocked → flow cache stale
}

let _mapW = 0;
let _mapH = 0;
const _teams = new Map<number, TeamVision>();

export function initVision(mapW: number, mapH: number, teams: number[]): void {
    _mapW = mapW;
    _mapH = mapH;
    _teams.clear();
    for (const t of teams) {
        _teams.set(t, {
            explored:     new Uint8Array(mapW * mapH),   // nothing explored yet
            believedPass: new Uint8Array(mapW * mapH),   // all assumed passable
            dirty:        false,
        });
    }
}

/** Fold each team's current visibility into its explored map.  Newly-explored tiles
 *  adopt their real passability; if that reveals a blocked tile, mark that team's
 *  flow cache dirty. */
export function visionSystem(world: SimWorld): void {
    if (_teams.size === 0) return;
    const realPass = getPassability();
    if (!realPass) return;
    const mapW = _mapW, mapH = _mapH;

    for (const eid of query(world, [Position, Unit, MoveTarget])) {
        const tv = _teams.get(Unit.team[eid]);
        if (!tv) continue;
        const sight = unitSight(Unit.type[eid]);
        const utx = Path.curTx[eid];
        const uty = Path.curTy[eid];
        const tx0 = Math.max(0,        utx - sight);
        const tx1 = Math.min(mapW - 1, utx + sight);
        const ty0 = Math.max(0,        uty - sight);
        const ty1 = Math.min(mapH - 1, uty + sight);
        for (let ty = ty0; ty <= ty1; ty++) {
            for (let tx = tx0; tx <= tx1; tx++) {
                if (!inRange(tx - utx, ty - uty, sight)) continue;
                const i = ty * mapW + tx;
                if (tv.explored[i]) continue;          // already known
                tv.explored[i] = 1;
                tv.believedPass[i] = realPass[i];      // learn the real terrain here
                if (realPass[i]) tv.dirty = true;
            }
        }
    }
}

/** Believed passability for a team's pathfinding (null in pre-map dev mode). */
export function getBelievedPassability(team: number): Uint8Array | null {
    return _teams.get(team)?.believedPass ?? null;
}

/** True if tile (tx,ty) has ever been explored by `team`. */
export function isExplored(team: number, tx: number, ty: number): boolean {
    const tv = _teams.get(team);
    return !!tv && tx >= 0 && tx < _mapW && ty >= 0 && ty < _mapH
        && tv.explored[ty * _mapW + tx] === 1;
}

/** Read-and-clear a team's dirty flag: true once after its newly-explored terrain
 *  proved blocked (so the caller can drop that team's stale flow fields). */
export function takeBelievedDirty(team: number): boolean {
    const tv = _teams.get(team);
    if (!tv || !tv.dirty) return false;
    tv.dirty = false;
    return true;
}

/** Debug/e2e: mark the whole map explored for every team so pathfinding uses the real passability
 *  (no fog). Lets scenarios test obstacle routing directly, without fog-of-war discovery in the loop. */
export function revealAll(): void {
    const realPass = getPassability();
    for (const tv of _teams.values()) {
        tv.explored.fill(1);
        if (realPass) tv.believedPass.set(realPass); else tv.believedPass.fill(0);
        tv.dirty = true;   // force each team's flow cache to rebuild against the now-known terrain
    }
}

/** Serialize every team's explored state for the deterministic snapshot. */
export function exportExplored(): [number, number[]][] {
    return [..._teams].map(([team, tv]) => [team, Array.from(tv.explored)]);
}

/** Restore explored state from a snapshot and rebuild each team's believedPass. */
export function importExplored(entries: [number, number[]][]): void {
    const realPass = getPassability();
    for (const [team, data] of entries) {
        const tv = _teams.get(team);
        if (!tv) continue;
        for (let i = 0; i < tv.explored.length; i++) {
            const e = data[i] ? 1 : 0;
            tv.explored[i] = e;
            tv.believedPass[i] = e && realPass ? realPass[i] : 0;
        }
        tv.dirty = true;   // force a flow-cache clear after a restore
    }
}
