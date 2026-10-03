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
import { createComponents, simFields } from "../sim/components.ts";
import { fold } from "../sim/hash.ts";
import { snapshotUnit } from "../sim/snapshot.ts";
import { unitTypeName } from "../sim/unitTypes.ts";
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

/** A unit as the tools and the debug canvas show it: by name, with what matters to look at. */
export interface UnitInfo {
	"uid": number;
	"team": number;
	"type": string;
	/** Fixed-point centre. */
	"x": number;
	"y": number;
	"moving": boolean;
	/** Facing, 0–7 clockwise from north. */
	"dir": number;
	/** Its move target, while it has one (absent for an enemy: the view doesn't carry it). */
	"target"?: [number, number];
	"building"?: { "w": number; "h": number; "buildLeft": number };
	/** An own unit's queue state (an enemy's isn't in the view): shift-queued orders, a building's production
	 *  (product type names) and rally point. */
	"orders"?: UnitSnapshot["orders"];
	"production"?: { "queue": string[]; "ticksLeft": number; "ticksTotal": number };
	"rally"?: [number, number];
}

/** The sim's field names, in order (every world's are the same): how a UnitSnapshot's values are read. */
const FIELDS = simFields(createComponents()).map(([name]) => name);
const INDEX = new Map(FIELDS.map((name, index) => [name, index]));

/** A field of a unit snapshot, by name. */
export function valueOf(unit: UnitSnapshot, name: string): number {
	return unit.values[INDEX.get(name)];
}

export function describe(unit: UnitSnapshot): UnitInfo {
	const info: UnitInfo = { "uid": unit.uid, "team": valueOf(unit, "Unit.team"), "type": unitTypeName(valueOf(unit, "Unit.type")), "x": valueOf(unit, "Position.x"), "y": valueOf(unit, "Position.y"), "moving": valueOf(unit, "UnitAnim.moving") === 1, "dir": valueOf(unit, "UnitAnim.dir") };

	if (valueOf(unit, "MoveTarget.active") === 1 && (valueOf(unit, "MoveTarget.tx") !== 0 || valueOf(unit, "MoveTarget.ty") !== 0)) {
		info.target = [valueOf(unit, "MoveTarget.tx"), valueOf(unit, "MoveTarget.ty")];
	}

	if (valueOf(unit, "Building.fw") > 0) {
		info.building = { "w": valueOf(unit, "Building.fw"), "h": valueOf(unit, "Building.fh"), "buildLeft": valueOf(unit, "Building.buildLeft") };
	}

	if (unit.orders !== undefined) {
		info.orders = unit.orders;
	}

	if (unit.prod !== undefined) {
		info.production = { "queue": unit.prod.queue.map(unitTypeName), "ticksLeft": unit.prod.ticksLeft, "ticksTotal": unit.prod.ticksTotal };
	}

	if (unit.rally !== undefined) {
		info.rally = [unit.rally.txFP, unit.rally.tyFP];
	}

	return info;
}

/** What a client worker sends its instance to draw, each tick (contract.ts `instanceSubjects(id).view`). */
export interface InstanceView {
	"id": string;
	"team": number | undefined;
	"viewTick": number;
	"inSync": boolean;
	/** The match's map, by name (the instance loads it itself). */
	"map": string | undefined;
	/** The authoritative view. */
	"units": UnitInfo[];
	/** This team's units as predicted locally. */
	"predicted": UnitInfo[];
	/** What this team has explored, as runs ([start, length, …] over flat tile indices). */
	"explored": number[];
	"selected": number[];
	"stats": Record<string, number>;
	/** The seat token, for the instance to keep across a reload. State, sent with every view. */
	"token": string | undefined;
}
