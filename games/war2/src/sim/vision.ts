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
 * The world's (`world.vision`), keyed by team.
 */
import type { SimWorld } from "./world.ts";
import { query } from "bitecs";
import { inRange } from "./distance.ts";
import { unitSight } from "./unitTypes.ts";

/** Default/fallback sight radius in tiles (per-unit sight comes from unitSight()).
 *  Canonical source — re-exported by world.ts; the renderer keeps a matching copy. */
export const FOW_SIGHT_TILES = 4;

export interface TeamVision {
	"explored": Uint8Array;   // 0 = unexplored, 1 = explored (persists)
	"believedPass": Uint8Array;   // 0 = passable, 1 = blocked (only where explored)
	"dirty": boolean;      // newly-explored terrain proved blocked → flow cache stale
}

/** Each of `teams`' vision of a mapW×mapH map: nothing explored, everything assumed passable. */
export function createVision(mapW: number, mapH: number, teams: number[]): Map<number, TeamVision> {
	return new Map(teams.map((team) => [team, {
		"explored": new Uint8Array(mapW * mapH),   // nothing explored yet
		"believedPass": new Uint8Array(mapW * mapH),   // all assumed passable
		"dirty": false
	}]));
}

/** Fold each team's current visibility into its explored map.  Newly-explored tiles
 *  adopt their real passability; if that reveals a blocked tile, mark that team's
 *  flow cache dirty. */
export function visionSystem(world: SimWorld): void {
	if (!world.exploring || world.vision.size === 0) { return; }
	const realPass = world.terrain.pass;

	if (!realPass) { return; }
	const { w: mapW, h: mapH } = world.terrain;
	const { MoveTarget, Path, Position, Unit } = world.components;

	for (const eid of query(world, [Position, Unit, MoveTarget])) {
		const tv = world.vision.get(Unit.team[eid]);

		if (!tv) { continue; }
		const sight = unitSight(Unit.type[eid]);
		const utx = Path.curTx[eid];
		const uty = Path.curTy[eid];
		const tx0 = Math.max(0, utx - sight);
		const tx1 = Math.min(mapW - 1, utx + sight);
		const ty0 = Math.max(0, uty - sight);
		const ty1 = Math.min(mapH - 1, uty + sight);

		for (let ty = ty0; ty <= ty1; ty++) {
			for (let tx = tx0; tx <= tx1; tx++) {
				if (!inRange(tx - utx, ty - uty, sight)) { continue; }
				const i = ty * mapW + tx;

				if (tv.explored[i]) { continue; }          // already known
				tv.explored[i] = 1;
				tv.believedPass[i] = realPass[i];      // learn the real terrain here
				if (realPass[i]) { tv.dirty = true; }
			}
		}
	}
}

/** Believed passability for a team's pathfinding (null in pre-map dev mode). */
export function getBelievedPassability(world: SimWorld, team: number): Uint8Array | null {
	return world.vision.get(team)?.believedPass ?? null;
}

/** Read-and-clear a team's dirty flag: true once after its newly-explored terrain
 *  proved blocked (so the caller can drop that team's stale flow fields). */
export function takeBelievedDirty(world: SimWorld, team: number): boolean {
	const tv = world.vision.get(team);

	if (!tv?.dirty) { return false; }
	tv.dirty = false;

	return true;
}

/** Debug/e2e: mark the whole map explored for every team so pathfinding uses the real passability
 *  (no fog). Lets scenarios test obstacle routing directly, without fog-of-war discovery in the loop. */
export function revealAll(world: SimWorld): void {
	const realPass = world.terrain.pass;

	for (const tv of world.vision.values()) {
		tv.explored.fill(1);
		if (realPass) { tv.believedPass.set(realPass); } else { tv.believedPass.fill(0); }
		tv.dirty = true;   // force each team's flow cache to rebuild against the now-known terrain
	}
}

/** `team`'s explored tiles, as runs: [start, length, start, length, …] over the flat tile index. */
export function exploredRuns(world: SimWorld, team: number): number[] {
	const explored = world.vision.get(team)?.explored;
	const runs: number[] = [];

	if (explored === undefined) {
		return runs;
	}

	for (let i = 0; i < explored.length; i++) {
		if (explored[i] === 1 && (i === 0 || explored[i - 1] === 0)) {
			runs.push(i, 1);
		} else if (explored[i] === 1) {
			runs[runs.length - 1] += 1;
		}
	}

	return runs;
}

/** Mark `tiles` (flat indices) explored for `team`, learning their real terrain — as visionSystem would on sight. For
 *  a world told what its team has explored rather than exploring itself (`world.exploring` false). */
export function exploreTiles(world: SimWorld, team: number, tiles: Iterable<number>): void {
	const tv = world.vision.get(team);
	const realPass = world.terrain.pass;

	if (tv === undefined || !realPass) {
		return;
	}

	for (const i of tiles) {
		if (tv.explored[i] === 1 || i < 0 || i >= tv.explored.length) { continue; }
		tv.explored[i] = 1;
		tv.believedPass[i] = realPass[i];
		if (realPass[i]) { tv.dirty = true; }
	}
}

/** Serialize every team's explored state for the deterministic snapshot. */
export function exportExplored(world: SimWorld): [number, number[]][] {
	return [...world.vision].map(([team, tv]) => [team, Array.from(tv.explored)]);
}

/** Restore explored state from a snapshot and rebuild each team's believedPass. */
export function importExplored(world: SimWorld, entries: [number, number[]][]): void {
	const realPass = world.terrain.pass;

	for (const [team, data] of entries) {
		const tv = world.vision.get(team);

		if (!tv) { continue; }
		for (let i = 0; i < tv.explored.length; i++) {
			const e = data[i] ? 1 : 0;

			tv.explored[i] = e;
			tv.believedPass[i] = e && realPass ? realPass[i] : 0;
		}

		tv.dirty = true;   // force a flow-cache clear after a restore
	}
}

// ── Per-unit visibility queries ───────────────────────────────────────────────
// Which UIDs / tiles a team can currently see, by each unit's own sight radius.
// (Folded in from world.ts — these are vision queries, so they belong here.)

/**
 * Returns the set of stable UnitIds visible to observerTeam.
 * Own units are always included; an enemy unit is included if it lies within the
 * observing* unit's own sight radius (per-unit, unitSight; dodecagonal metric).
 */
export function computeVisibleUids(world: SimWorld, observerTeam: number): Set<number> {
	const { MoveTarget, Path, Position, Unit, UnitId } = world.components;
	const eids = [...query(world, [Position, Unit, MoveTarget])];
	const myEids: number[] = [];
	const visible = new Set<number>();

    // Collect own-team eids and mark them visible in one pass (avoids .filter() alloc)
	for (const e of eids) {
		if (Unit.team[e] === observerTeam) { visible.add(UnitId.id[e]); myEids.push(e); }
	}

    // Check enemy proximity against the collected own-team positions
	for (const e of eids) {
		if (Unit.team[e] === observerTeam) { continue; }
		const etx = Path.curTx[e]; const
			ety = Path.curTy[e];

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
	const { MoveTarget, Path, Position, Unit } = world.components;

	for (const e of query(world, [Position, Unit, MoveTarget])) {
		if (Unit.team[e] !== observerTeam) { continue; }
		if (inRange(Path.curTx[e] - tx, Path.curTy[e] - ty, unitSight(Unit.type[e]))) { return true; }
	}

	return false;
}
