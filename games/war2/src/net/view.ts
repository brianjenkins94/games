/**
 * A team's view: what the referee sends it, and what a client holds — the referee's fog of war, enforced by never
 * sending the rest.
 *
 * - Its own units, whole: every sim field, plus their queued orders, production and rally points (sim/snapshot.ts).
 * - Every enemy unit within sight of one of them (sim/vision.ts computeVisibleUids), reduced to what it shows: where it
 *   is, what it is, whether it's moving and which way it faces, and a building's footprint and progress. Not where
 *   it's headed or how it's getting there (move target, path goal, corridor), nor its queues — that would be reading
 *   the other player's orders. The rest of its fields go as zero.
 * - What the team has explored (its own knowledge), so a client's pathing believes what authority's does.
 *
 * `hashView` is computed over exactly this, in stable-id order, at both ends: equal hashes mean an exact copy.
 */
import type { UnitSnapshot } from "../sim/types.ts";
import type { SimWorld } from "../sim/world.ts";
import { fold } from "../sim/hash.ts";
import { snapshotUnit } from "../sim/snapshot.ts";
import { computeVisibleUids } from "../sim/vision.ts";
import { unitEids } from "../sim/world.ts";

/** The sim fields a team sees of an enemy in sight. */
export const PUBLIC_FIELDS: ReadonlySet<string> = new Set([
	"Position.x", "Position.y", "Unit.team", "Unit.type", "UnitId.id", "MoveTarget.active", "UnitAnim.dir", "UnitAnim.moving",
	"Path.curTx", "Path.curTy", "Building.fw", "Building.fh", "Building.buildLeft"
]);

/** `team`'s view of `world`'s units, in stable-id order. */
export function teamView(world: SimWorld, team: number): UnitSnapshot[] {
	const { Unit, UnitId } = world.components;
	const visible = computeVisibleUids(world, team);

	return unitEids(world)
		.filter((eid) => visible.has(UnitId.id[eid]))
		.sort((a, b) => UnitId.id[a] - UnitId.id[b])
		.map((eid) => (Unit.team[eid] === team ? snapshotUnit(world, eid) : { "uid": UnitId.id[eid], "values": world.fields.map(([name, column]) => (PUBLIC_FIELDS.has(name) ? column[eid] : 0)) }));
}

/** A hash of a view — its units (in stable-id order, each as sent) and what the team has explored (as runs). */
export function hashView(units: Iterable<UnitSnapshot>, exploredRuns: number[]): number {
	let hash = 2166136261;

	for (const unit of units) {
		for (const char of JSON.stringify(unit)) {
			hash = fold(hash, char.charCodeAt(0));
		}
	}

	for (const value of exploredRuns) {
		hash = fold(hash, value);
	}

	return hash;
}
