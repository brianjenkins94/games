/**
 * A client: joins a match, keeps the authoritative view of what its team can see, and predicts its own units so a
 * command shows immediately rather than a round trip later.
 *
 * - The view only ever advances: a keyframe replaces it, a delta applies only on top of the exact update it was built
 *   against. A missing, late or duplicated update is dropped and the client asks for a keyframe — so loss and
 *   reordering can delay the view but never corrupt it. After every update the view is hashed and checked against
 *   the referee's hash of the same set; a mismatch counts as a desync and also triggers a resync.
 * - Commands go out in numbered batches, resent every tick until the referee acknowledges them.
 * - Prediction runs the same sim on a world holding only this team's units, corrected from each authoritative update.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Unit, World, WorldConfig } from "../sim/index.ts";
import type { CommandBatch, JoinReply, JoinRequest, ResyncRequest, StateUpdate } from "./protocol.ts";
import { createRpcClient } from "@brianjenkins94/hub";
import { applyCommand, approxDistance, createWorld, decodeUnit, hashUnits, stepWorld } from "../sim/index.ts";
import { subjects } from "./protocol.ts";

export interface ClientOptions {
	"hub": Hub;
	"match": string;
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
	"config": () => WorldConfig | undefined;
	/** Join (or, with the token of an earlier join, rejoin). Resolves once seated. */
	"join": (options?: { "token"?: string; "timeoutMs"?: number }) => Promise<JoinReply>;
	/** The authoritative view: every unit this team can see, as of `viewTick`. */
	"view": () => Map<number, Unit>;
	"viewTick": () => number;
	"viewHash": () => number;
	/** Whether the last update applied matched the referee's hash (false until the first one). */
	"inSync": () => boolean;
	/** This team's units as predicted locally (ahead of the view). */
	"predicted": () => World | undefined;
	/** Queue a command: applied to the prediction now, sent on the next `tick()`. */
	"command": (command: unknown) => void;
	/** Advance the prediction one tick and send what's unacknowledged. */
	"tick": () => void;
	"stats": ClientStats;
	"close": () => void;
}

/** How far a predicted unit may drift from authority before it's snapped back, in ticks of movement. */
const SNAP_TICKS = 8;

export function createClient({ hub, match }: ClientOptions): Client {
	const names = subjects(match);
	const rpc = createRpcClient(hub);
	const stats: ClientStats = { "updates": 0, "keyframes": 0, "stale": 0, "gaps": 0, "desyncs": 0, "resyncRequests": 0, "batchesSent": 0, "snaps": 0 };
	let seat: JoinReply | undefined;
	let view = new Map<number, Unit>();
	let viewTick = -1;
	let predicted: World | undefined;
	let unsubscribe: (() => void) | undefined;
	let queued: unknown[] = [];
	let unacked: CommandBatch[] = [];
	let nextSeq = 1;
	let wantResync = false;
	let inSync = false;

	function hashView(): number {
		return hashUnits([...view.values()].sort((left, right) => left.id - right.id));
	}

	function reconcile(): void {
		const own = [...view.values()].filter((unit) => unit.team === seat.team);
		const snapDistance = seat.config.speed * SNAP_TICKS;

		for (const authority of own) {
			const guess = predicted.units.get(authority.id);
			const settled = unacked.length === 0 && queued.length === 0;
			const off = guess === undefined
				|| approxDistance(guess.x - authority.x, guess.y - authority.y) > snapDistance
				// With nothing in flight the prediction must agree on where each unit is headed, and on where it is once
				// both have stopped.
				|| (settled && (guess.tx !== authority.tx || guess.ty !== authority.ty))
				|| (settled && guess.moving === 0 && authority.moving === 0 && (guess.x !== authority.x || guess.y !== authority.y));

			if (off) {
				if (guess !== undefined) {
					stats.snaps += 1;
				}

				predicted.units.set(authority.id, { ...authority });
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
			view = new Map(update.units.map((values) => {
				const unit = decodeUnit(values);

				return [unit.id, unit];
			}));
			stats.keyframes += 1;
		} else if (update.baseTick === viewTick) {
			for (const values of update.units) {
				const unit = decodeUnit(values);

				view.set(unit.id, unit);
			}

			for (const id of update.removed) {
				view.delete(id);
			}
		} else {
			stats.gaps += 1;
			wantResync = true;

			return;
		}

		viewTick = update.tick;

		inSync = hashView() === update.viewHash;

		if (!inSync) {
			stats.desyncs += 1;
			wantResync = true;
		}

		unacked = unacked.filter((batch) => batch.seq > update.ackSeq);
		reconcile();
	}

	return {
		"team": () => seat?.team,
		"config": () => seat?.config,
		"join": async ({ token, timeoutMs = 5000 } = {}) => {
			const request: JoinRequest = token === undefined ? {} : { "token": token };

			seat = await rpc.request(names.join, request, { "timeoutMs": timeoutMs, "waitForResponderMs": timeoutMs }) as JoinReply;
			view = new Map();
			viewTick = -1;
			predicted = createWorld(seat.config);
			unsubscribe?.();
			unsubscribe = hub.subscribe(names.state(seat.team), (data) => { onUpdate(data as StateUpdate); });

			return seat;
		},
		"view": () => view,
		"viewTick": () => viewTick,
		"viewHash": hashView,
		"inSync": () => inSync,
		"predicted": () => predicted,
		"command": (command) => {
			if (seat === undefined) {
				throw new Error("command before join");
			}

			applyCommand(predicted, seat.team, command);
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
