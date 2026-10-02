/**
 * A client: joins a match, keeps the authoritative view of what its team can see (view.ts), and predicts its own
 * units so a command shows at once rather than a round trip later. netsim's client (W2, see MIGRATION.md), with war2's
 * sim doing the predicting.
 *
 * - The view only ever advances: a keyframe replaces it, a delta applies only on top of the exact update it was built
 *   against. A missing, late or duplicated update is dropped and the client asks for a keyframe — so loss and
 *   reordering can delay the view but never corrupt it. After every update the view is hashed and checked against the
 *   referee's hash of the same view; a mismatch counts as a desync and also triggers a resync.
 * - Commands go out in numbered batches, resent every tick until the referee acknowledges them.
 * - Prediction runs war2's sim on a world of the client's own (`predicted`): its team's units, simulated; the enemies
 *   it can see, as display-only colliders (they're only ever where the view says); and what its team has explored,
 *   from the view — so its pathing believes what authority's does. MOVE and STOP apply to it at once; each update
 *   corrects it (`reconcile`).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Command } from "../sim/command.ts";
import type { UnitSnapshot } from "../sim/types.ts";
import type { MapInfo, SimWorld } from "../sim/world.ts";
import type { CommandBatch, JoinReply, JoinRequest, ResyncRequest, StateUpdate } from "./protocol.ts";
import { createRpcClient } from "@brianjenkins94/hub";
import { CmdType } from "../sim/command.ts";
import { UNIT_SPD } from "../sim/components.ts";
import { distance } from "../sim/distance.ts";
import { addKnownUnit, addOwnUnit, reconcileOwnUnit, removeKnownUnit, updateKnownUnit } from "../sim/snapshot.ts";
import { applyCommands } from "../sim/systems/commands.ts";
import { exploredRuns, exploreTiles } from "../sim/vision.ts";
import { createSimWorld, eidForUnitId, stepWorld } from "../sim/world.ts";
import { subjects } from "./protocol.ts";
import { hashView } from "./view.ts";

export interface ClientOptions {
	"hub": Hub;
	"match": string;
	/** A map's sim form, by the name the referee gives in its join reply (fetched, in a browser). */
	"loadMap": (name: string) => MapInfo | Promise<MapInfo>;
}

export interface ClientStats {
	"updates": number;
	"keyframes": number;
	/** Updates at or before the current view tick (duplicates, reordered). */
	"stale": number;
	/** Deltas whose base wasn't the current view — something before them was lost. */
	"gaps": number;
	/** Views whose hash disagreed with the referee's. */
	"desyncs": number;
	"resyncRequests": number;
	"batchesSent": number;
	/** Predicted own units snapped back to authority. */
	"snaps": number;
}

export interface Client {
	"team": () => number | undefined;
	/** Join (or, with the token of an earlier join, rejoin). Resolves once seated. */
	"join": (options?: { "token"?: string; "timeoutMs"?: number }) => Promise<JoinReply>;
	/** The authoritative view: every unit this team can see, by stable id, as of `viewTick`. */
	"view": () => Map<number, UnitSnapshot>;
	"viewTick": () => number;
	"viewHash": () => number;
	/** Whether the last update applied matched the referee's hash (false until the first one). */
	"inSync": () => boolean;
	/** The prediction: this team's units ahead of the view, the enemies it can see, what it has explored. */
	"predicted": () => SimWorld | undefined;
	/** Queue a command: MOVE and STOP apply to the prediction now; everything is sent on the next `tick()`. */
	"command": (command: Command) => void;
	/** Advance the prediction one tick and send what's unacknowledged. */
	"tick": () => void;
	"stats": ClientStats;
	"close": () => void;
}

/** How far a predicted unit may drift from authority before it's snapped back, in ticks of movement. */
const SNAP_TICKS = 8;

export function createClient({ hub, match, loadMap }: ClientOptions): Client {
	const names = subjects(match);
	const rpc = createRpcClient(hub);
	const stats: ClientStats = { "updates": 0, "keyframes": 0, "stale": 0, "gaps": 0, "desyncs": 0, "resyncRequests": 0, "batchesSent": 0, "snaps": 0 };
	let seat: JoinReply | undefined;
	let view = new Map<number, UnitSnapshot>();
	let viewTick = -1;
	let predicted: SimWorld | undefined;
	let field: Map<string, number> = new Map();
	let unsubscribe: (() => void) | undefined;
	let queued: Command[] = [];
	let unacked: CommandBatch[] = [];
	let nextSeq = 1;
	let wantResync = false;
	let inSync = false;

	function hashOfView(): number {
		return hashView([...view.values()].sort((left, right) => left.uid - right.uid), predicted === undefined ? [] : exploredRuns(predicted, seat.team));
	}

	/** A field of a unit as the view has it. */
	function valueOf(unit: UnitSnapshot, name: string): number {
		return unit.values[field.get(name)];
	}

	/** Bring the prediction in line with the view: every unit in it, every unit gone from it gone, and each own unit
	 *  snapped back to authority if it's drifted — or, with nothing in flight, if it disagrees on where it's headed, or
	 *  on where it stopped. */
	function reconcile(removed: number[]): void {
		const { MoveTarget, Position, UnitId } = predicted.components;
		const settled = unacked.length === 0 && queued.length === 0;

		for (const uid of removed) {
			const eid = eidForUnitId(predicted, uid);

			if (eid !== undefined) {
				removeKnownUnit(predicted, eid);
				delete predicted.orders?.[uid];
			}
		}

		for (const unit of view.values()) {
			const eid = eidForUnitId(predicted, unit.uid);

			if (valueOf(unit, "Unit.team") !== seat.team) {
				if (eid === undefined) {
					addKnownUnit(predicted, unit);
				} else {
					updateKnownUnit(predicted, eid, unit);
				}

				continue;
			}

			const [x, y, active] = [valueOf(unit, "Position.x"), valueOf(unit, "Position.y"), valueOf(unit, "MoveTarget.active")];
			const off = eid === undefined
				|| distance(Position.x[eid] - x, Position.y[eid] - y) > UNIT_SPD * SNAP_TICKS
				// With nothing in flight it must agree on where the unit is headed — not on whether it's still moving: the
				// prediction runs a round trip ahead, so it arrives first — and on where it is once both have stopped.
				|| (settled && (MoveTarget.tx[eid] !== valueOf(unit, "MoveTarget.tx") || MoveTarget.ty[eid] !== valueOf(unit, "MoveTarget.ty")))
				|| (settled && active === 0 && MoveTarget.active[eid] === 0 && (Position.x[eid] !== x || Position.y[eid] !== y));

			if (!off) {
				continue;
			}

			if (eid === undefined) {
				addOwnUnit(predicted, unit);
			} else {
				stats.snaps += 1;
				reconcileOwnUnit(predicted, eid, unit);
			}

			predicted.orders ??= {};

			if (unit.orders === undefined) {
				delete predicted.orders[unit.uid];
			} else {
				predicted.orders[unit.uid] = unit.orders.map((order) => ({ ...order }));
			}
		}

		// Units the view no longer has (removed before this client's view began, say) don't linger in the prediction.
		for (const [uid, eid] of [...predicted.eidOf]) {
			if (!view.has(uid) && UnitId.id[eid] === uid) {
				removeKnownUnit(predicted, eid);
			}
		}
	}

	function onUpdate(update: StateUpdate): void {
		stats.updates += 1;

		if (update.tick <= viewTick) {
			stats.stale += 1;

			return;
		}

		if (update.baseTick === null) {
			view = new Map(update.units.map((unit) => [unit.uid, unit]));
			stats.keyframes += 1;

			const tiles: number[] = [];

			for (let index = 0; index < update.explored.length; index += 2) {
				for (let tile = update.explored[index]; tile < update.explored[index] + update.explored[index + 1]; tile += 1) {
					tiles.push(tile);
				}
			}

			exploreTiles(predicted, seat.team, tiles);
		} else if (update.baseTick === viewTick) {
			for (const unit of update.units) {
				view.set(unit.uid, unit);
			}

			for (const uid of update.removed) {
				view.delete(uid);
			}

			exploreTiles(predicted, seat.team, update.explored);
		} else {
			stats.gaps += 1;
			wantResync = true;

			return;
		}

		viewTick = update.tick;
		inSync = hashOfView() === update.viewHash;

		if (!inSync) {
			stats.desyncs += 1;
			wantResync = true;
		}

		unacked = unacked.filter((batch) => batch.seq > update.ackSeq);
		reconcile(update.baseTick === null ? [] : update.removed);
	}

	return {
		"team": () => seat?.team,
		"join": async ({ token, timeoutMs = 5000 } = {}) => {
			const request: JoinRequest = token === undefined ? {} : { "token": token };

			const reply = await rpc.request(names.join, request, { "timeoutMs": timeoutMs, "waitForResponderMs": timeoutMs }) as JoinReply;
			const map = await loadMap(reply.map);

			seat = reply;
			// Carry on the seat's sequence. (A client re-joining on a new link is already there: its own unacked batches
			// are the ones the seat hasn't taken in yet, and it resends them in order.)
			nextSeq = Math.max(nextSeq, seat.nextSeq);
			view = new Map();
			viewTick = -1;
			predicted = createSimWorld(seat.seed, map, seat.teams);
			predicted.exploring = false;   // what the team has explored comes from the view
			field = new Map(predicted.fields.map(([name], index) => [name, index]));
			unsubscribe?.();
			unsubscribe = hub.subscribe(names.state(seat.team), (data) => { onUpdate(data as StateUpdate); });

			return seat;
		},
		"view": () => view,
		"viewTick": () => viewTick,
		"viewHash": hashOfView,
		"inSync": () => inSync,
		"predicted": () => predicted,
		"command": (command) => {
			if (seat === undefined) {
				throw new Error("command before join");
			}

			if (command.type === CmdType.MOVE || command.type === CmdType.STOP) {
				applyCommands(predicted, [command]);
			}

			queued.push(command);
		},
		"tick": () => {
			if (seat === undefined) {
				return;
			}

			stepWorld(predicted);

			if (queued.length > 0) {
				unacked.push({ "seq": nextSeq, "commands": queued });
				nextSeq += 1;
				queued = [];
			}

			for (const batch of unacked) {
				hub.publish(names.commands, batch);
				stats.batchesSent += 1;
			}

			if (wantResync) {
				hub.publish(names.commands, { "resync": true } satisfies ResyncRequest);
				stats.resyncRequests += 1;
				wantResync = false;
			}
		},
		"stats": stats,
		"close": () => {
			unsubscribe?.();
			unsubscribe = undefined;
		}
	};
}
