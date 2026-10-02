/**
 * The pathology detector: a read-only scan after each tick for units the pathing has failed (W4, see MIGRATION.md).
 * Carried from the old war2's referee, as an instance — its tracking is its own, so any number of detectors (one per
 * referee, one per test) scan side by side. It never touches the sim, so determinism holds.
 *
 * A unit is flagged as:
 * - **give-up** — ordered alone to move this tick, but ended it idle, more than a tile from the target (a group spreads
 *   to slots around the click, so only a lone unit's give-up is plain);
 * - **stuck** — moving, but grinding toward the settle limit (movement.ts STUCK_LIMIT);
 * - **settled-short** — just stopped, not told to, more than a tile from the slot it was steering for;
 * - **oscillating** — moving, but bouncing between two tiles over its last few tile changes;
 * - **stalled** — moving, but no closer to its target for STALL_TICKS — neither in a straight line nor along its route
 *   (its flow field's cost to go, so a unit going round terrain, or through fog its team believes open, is making
 *   progress while the straight line grows). It may be jittering in place (a few pixels to and fro each tick), which
 *   keeps resetting its stall counter, so it never escalates and never settles: what W0's traces caught in
 *   pinch-corridor and production-rally;
 * - **stacked** — moving, and overlapping a moving teammate (within STACK_FP) for STACK_TICKS running: movers pass
 *   through movers, so units sharing a route travel piled on each other (W6 step 0).
 *
 * The old detector's give-up and settled-short also fired on a group's units already in their slots and on units
 * just stopped; those are left out (W4).
 */
import type { Command } from "../sim/command.ts";
import type { SimWorld } from "../sim/world.ts";
import { hasComponent } from "bitecs";
import { CmdType } from "../sim/command.ts";
import { fpToTile } from "../sim/components.ts";
import { distance } from "../sim/distance.ts";
import { INF, peekFlowField } from "../sim/flowField.ts";
import { unitEids } from "../sim/world.ts";

export type Pathology = "give-up" | "stuck" | "settled-short" | "oscillating" | "stalled" | "stacked";

/** stuckTicks at which a moving unit counts as stuck: about two thirds of the way to the settle limit (36). */
export const STUCK_FLAG = 24;
/** How many distinct consecutive tiles to look back over for bouncing. */
export const OSC_WINDOW = 6;
/** Ticks a moving unit may go without getting closer to its target before it counts as stalled (5 s). */
export const STALL_TICKS = 100;
/** What counts as getting closer: a quarter tile, fixed-point. */
const PROGRESS_FP = 8000;
/** Two moving teammates closer than this (L1, fixed-point: 12 px, so two 32 px units more than half overlapped) are
 *  on top of each other. */
export const STACK_FP = 12000;
/** Ticks running two movers must stay that close to count as stacked (2.5 s). */
export const STACK_TICKS = 50;

interface Track {
	"prevMove": number;
	"prevSlotTx": number;
	"prevSlotTy": number;
	/** The unit's last tiles, each different from the one before. */
	"tiles": number[];
	/** The tick it started grinding, while it is (-1 otherwise). */
	"stuckSince": number;
	/** Its target, the closest it's come to it, and the tick it last got closer. */
	"tx": number;
	"ty": number;
	"best": number;
	/** The least cost to go along its route it's had (its flow field's; Infinity without one). */
	"routeBest": number;
	/** Its cost to go at its tile last scan, and that tile — to rebase routeBest when the field re-prices the route. */
	"routeLast": number;
	"routeLastTile": number;
	"bestAt": number;
}

export interface PathologyDetector {
	/** Scan `world` after a step that applied `applied`: every unit in trouble, by stable id, with what's wrong (the
	 *  first found wins). */
	"scan": (world: SimWorld, applied: readonly Command[]) => Map<number, Pathology>;
	/** The tick a unit started grinding, if it's stuck now. */
	"stuckSince": (uid: number) => number | undefined;
	/** Forget everything (a restored or replayed world starts clean). */
	"reset": () => void;
}

export function createPathologyDetector(): PathologyDetector {
	const tracks = new Map<number, Track>();
	/** "lowUid+highUid" → ticks running the two have been stacked. */
	const stacks = new Map<string, number>();

	return {
		"scan": (world, applied) => {
			const { Building, MoveTarget, Path, Position, Unit, UnitId } = world.components;
			const found = new Map<number, Pathology>();
			const stopped = new Set(applied.flatMap((command) => (command.type === CmdType.STOP ? command.unitIds : [])));

			for (const command of applied) {
				if (command.type !== CmdType.MOVE || command.unitIds.length !== 1 || command.queue === true) {
					continue;
				}

				const [ttx, tty] = [fpToTile(command.txFP), fpToTile(command.tyFP)];
				const [uid] = command.unitIds;
				const eid = world.eidOf.get(uid);

				if (eid !== undefined && MoveTarget.active[eid] === 0 && Math.max(Math.abs(Path.curTx[eid] - ttx), Math.abs(Path.curTy[eid] - tty)) > 1) {
					found.set(uid, "give-up");
				}
			}

			const live = new Set<number>();
			const movers: { "uid": number; "team": number; "x": number; "y": number }[] = [];
			const mapW = world.terrain.w;

			for (const eid of unitEids(world)) {
				if (hasComponent(world, eid, Building) || Unit.movable[eid] !== 1) {
					continue;
				}

				const uid = UnitId.id[eid];
				const moving = MoveTarget.active[eid];
				const tile = Path.curTy[eid] * 4096 + Path.curTx[eid];
				const track = tracks.get(uid) ?? { "prevMove": 0, "prevSlotTx": -999, "prevSlotTy": -999, "tiles": [], "stuckSince": -1, "tx": -1, "ty": -1, "best": Infinity, "routeBest": Infinity, "routeLast": Infinity, "routeLastTile": -1, "bestAt": world.tick };

				live.add(uid);

				if (moving === 1 && Path.stuckTicks[eid] >= STUCK_FLAG) {
					if (!found.has(uid)) {
						found.set(uid, "stuck");
					}

					if (track.stuckSince < 0) {
						track.stuckSince = world.tick;
					}
				} else {
					track.stuckSince = -1;
				}

				// Settled-short: just stopped (moving 1 → 0) more than a tile from the slot it was steering for — for any
				// reason: walled, slot taken, reflowed.
				if (track.prevMove === 1 && moving === 0 && !stopped.has(uid) && !found.has(uid) && Math.abs(Path.curTx[eid] - track.prevSlotTx) + Math.abs(Path.curTy[eid] - track.prevSlotTy) > 1) {
					found.set(uid, "settled-short");
				}

				if (track.tiles.at(-1) !== tile) {
					track.tiles.push(tile);
					track.tiles.splice(0, Math.max(0, track.tiles.length - OSC_WINDOW));
				}

				if (moving === 1 && track.tiles.length >= OSC_WINDOW && new Set(track.tiles).size <= 2 && !found.has(uid)) {
					found.set(uid, "oscillating");
				}

				const away = distance(MoveTarget.tx[eid] - Position.x[eid], MoveTarget.ty[eid] - Position.y[eid]);
				// Along the route: the cost to go at its tile, by the field it's steering on — if the sim has one cached
				// (peeked: watching must not change what the sim does next).
				const field = moving === 1 ? peekFlowField(world, Unit.team[eid], Path.goalTx[eid], Path.goalTy[eid]) : undefined;
				const routeCost = field?.cost[Path.curTy[eid] * mapW + Path.curTx[eid]];
				const route = routeCost === undefined || routeCost === INF ? Infinity : routeCost;
				// The field re-priced the route since the last scan (its team found a wall in the fog): shift the best by
				// as much, measured at the tile it was on — as movement does with its own best (Path.lastCost).
				const wasCost = field !== undefined && track.routeLastTile >= 0 ? field.cost[track.routeLastTile] : INF;

				if (wasCost !== INF && track.routeLast !== Infinity && track.routeBest !== Infinity) {
					track.routeBest += wasCost - track.routeLast;
				}

				[track.routeLast, track.routeLastTile] = [route, Path.curTy[eid] * mapW + Path.curTx[eid]];
				const retargeted = moving === 0 || MoveTarget.tx[eid] !== track.tx || MoveTarget.ty[eid] !== track.ty;

				// Each measure keeps its own best, moved only by its own progress, so either one going on counts.
				if (retargeted) {
					[track.tx, track.ty, track.best, track.routeBest, track.bestAt] = [MoveTarget.tx[eid], MoveTarget.ty[eid], moving === 0 ? Infinity : away, moving === 0 ? Infinity : route, world.tick];
				} else if (away <= track.best - PROGRESS_FP || route < track.routeBest) {
					if (away <= track.best - PROGRESS_FP) {
						track.best = away;
					}

					track.routeBest = Math.min(track.routeBest, route);
					track.bestAt = world.tick;
				} else if (world.tick - track.bestAt >= STALL_TICKS && !found.has(uid)) {
					found.set(uid, "stalled");
				}

				if (moving === 1) {
					movers.push({ "uid": uid, "team": Unit.team[eid], "x": Position.x[eid], "y": Position.y[eid] });
				}

				track.prevMove = moving;

				if (moving === 1) {
					track.prevSlotTx = fpToTile(MoveTarget.tx[eid]);
					track.prevSlotTy = fpToTile(MoveTarget.ty[eid]);
				}

				tracks.set(uid, track);
			}

			// Stacked: moving teammates on top of each other, tick after tick (a pair apart, or not both moving, starts over).
			const close = new Set<string>();

			for (let i = 0; i < movers.length; i += 1) {
				for (let j = i + 1; j < movers.length; j += 1) {
					const [a, b] = [movers[i], movers[j]];

					if (a.team !== b.team || Math.abs(a.x - b.x) + Math.abs(a.y - b.y) >= STACK_FP) {
						continue;
					}

					const key = `${Math.min(a.uid, b.uid)}+${Math.max(a.uid, b.uid)}`;
					const run = (stacks.get(key) ?? 0) + 1;

					close.add(key);
					stacks.set(key, run);

					if (run >= STACK_TICKS) {
						for (const uid of [a.uid, b.uid]) {
							if (!found.has(uid)) {
								found.set(uid, "stacked");
							}
						}
					}
				}
			}

			for (const key of stacks.keys()) {
				if (!close.has(key)) {
					stacks.delete(key);
				}
			}

			// Units that are gone are forgotten.
			for (const uid of tracks.keys()) {
				if (!live.has(uid)) {
					tracks.delete(uid);
				}
			}

			return found;
		},
		"stuckSince": (uid) => {
			const since = tracks.get(uid)?.stuckSince;

			return since === undefined || since < 0 ? undefined : since;
		},
		"reset": () => { tracks.clear(); stacks.clear(); }
	};
}
