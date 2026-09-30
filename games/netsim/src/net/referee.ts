/**
 * The referee: the one authoritative world. It seats clients (`join`), takes their command batches strictly in order,
 * and each tick sends every team what that team can see. Driven by `tick()` (a timer in a real match, the test loop in
 * a headless one).
 *
 * A client is its hub id — the envelope's `from`, which the hub it links to stamps (LinkOptions.peer). Where the
 * referee's own hub holds that link, seating a client also opens the link's permissions to exactly that seat
 * (`seatPermissions`): the referee publishes every team's view, and the hub lets each client receive only its own.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { World, WorldConfig } from "../sim/index.ts";
import type { CommandBatch, JoinReply, JoinRequest, RefereeTick, ResyncRequest, StateUpdate } from "./protocol.ts";
import { serve } from "@brianjenkins94/hub";
import { applyCommand, createWorld, encodeUnit, hashUnits, stepWorld, visibleUnits } from "../sim/index.ts";
import { lobbyPermissions, seatPermissions, subjects } from "./protocol.ts";

export interface RefereeOptions {
	"hub": Hub;
	"match": string;
	"config": WorldConfig;
	/** Populate the world before play (spawn units). */
	"setup"?: (world: World) => void;
	/** Send a keyframe at least this often (ticks). Default 10. */
	"keyframeEvery"?: number;
	/** The debug host's hub id (the page), when debugging is on: seated clients' links let it debug them. */
	"debugHost"?: string;
	/** Whether a client's link carries its observability (default: every client's). A client in another tab reports
	 *  to its own tab instead (PeerOptions.observed). */
	"observed"?: (peer: string) => boolean;
}

export interface RefereeStats {
	"ticks": number;
	"batchesApplied": number;
	/** Batches that weren't next in their client's sequence (duplicates, reordered, resends of applied ones). */
	"batchesOutOfOrder": number;
	/** Batches or resync requests from a hub that holds no seat. */
	"unknownSender": number;
	/** Messages on `commands` that were neither a batch nor a resync request. */
	"malformed": number;
	"commandsApplied": number;
	"commandsRejected": number;
	"keyframes": number;
	"deltas": number;
	/** Updates not sent because nobody was subscribed to that team's state yet. */
	"held": number;
	"resyncs": number;
}

interface Seat {
	"team": number;
	/** The hub id of the client holding the seat. */
	"peer": string;
	"token": string;
	/** The last batch taken in (queued for the next tick) — the sequence check. */
	"lastSeq": number;
	/** The last batch actually applied — what updates acknowledge, so a client never sees "acked" before its
	 *  commands show up in the authoritative state. */
	"appliedSeq": number;
	/** What we last sent this team: tick + each visible unit's encoding (the base of the next delta). */
	"lastTick": number | null;
	"lastUnits": Map<number, number[]>;
	"lastKeyframe": number;
	"needKeyframe": boolean;
}

export interface Referee {
	"world": World;
	"stats": RefereeStats;
	/** Apply the commands that arrived, step the world, and send every seated team its view. */
	"tick": () => void;
	/** Seated teams, for diagnostics. */
	"seats": () => { "team": number; "peer": string; "lastSeq": number }[];
	"close": () => void;
}

function isBatch(value: unknown): value is CommandBatch {
	const batch = value as CommandBatch | null;

	return typeof batch === "object" && batch !== null && Number.isSafeInteger(batch.seq) && Array.isArray(batch.commands);
}

function isResync(value: unknown): value is ResyncRequest {
	const request = value as ResyncRequest | null;

	return typeof request === "object" && request !== null && request.resync === true;
}

export function createReferee({ hub, match, config, setup, keyframeEvery = 10, debugHost, observed = () => true }: RefereeOptions): Referee {
	const world = createWorld(config);
	const names = subjects(match);
	/** By token. */
	const seats = new Map<string, Seat>();
	const seatOf = (peer: string | undefined): Seat | undefined => [...seats.values()].find((seat) => seat.peer === peer);
	const pending: { "seat": Seat; "seq": number; "commands": unknown[] }[] = [];
	const stats: RefereeStats = { "ticks": 0, "batchesApplied": 0, "batchesOutOfOrder": 0, "unknownSender": 0, "malformed": 0, "commandsApplied": 0, "commandsRejected": 0, "keyframes": 0, "deltas": 0, "held": 0, "resyncs": 0 };

	setup?.(world);

	/** Give `peer` the seat, and open its link (when our hub holds it) to exactly that seat. */
	function seatPeer(seat: Seat, peer: string): JoinReply {
		if (seat.peer !== peer) {
			// Moving the seat to a new link: the old one (if it's still there) goes back to the lobby.
			hub.permit(seat.peer, lobbyPermissions(match, seat.peer, { "debugHost": debugHost, "observed": observed(seat.peer) }));
			seat.peer = peer;
		}

		// Whatever the client had is gone (or never was): its next update is a keyframe.
		seat.needKeyframe = true;
		hub.permit(peer, seatPermissions(match, peer, seat.team, { "debugHost": debugHost, "observed": observed(peer) }));

		return { "team": seat.team, "token": seat.token, "config": world.config, "nextSeq": seat.lastSeq + 1 };
	}

	const stopServing = serve(hub, names.join, (args, { from }): JoinReply => {
		if (from === undefined) {
			throw new Error("join: the caller has no hub id");
		}

		const request = (args ?? {}) as JoinRequest;
		// A reconnect presents its token (it may be on a new link); a repeat join from the same hub keeps its seat.
		const existing = (typeof request.token === "string" ? seats.get(request.token) : undefined) ?? seatOf(from);

		if (existing !== undefined) {
			return seatPeer(existing, from);
		}

		const taken = new Set([...seats.values()].map((seat) => seat.team));
		const team = [...Array.from({ "length": world.config.teams }).keys()].find((candidate) => !taken.has(candidate));

		if (team === undefined) {
			throw new Error(`match ${match} is full`);
		}

		const seat: Seat = { "team": team, "peer": from, "token": crypto.randomUUID(), "lastSeq": 0, "appliedSeq": 0, "lastTick": null, "lastUnits": new Map(), "lastKeyframe": 0, "needKeyframe": true };

		seats.set(seat.token, seat);

		return seatPeer(seat, from);
	});

	const unsubscribe = hub.subscribe(names.commands, (data, envelope) => {
		const seat = seatOf(envelope.from);

		if (seat === undefined) {
			stats.unknownSender += 1;

			return;
		}

		if (isResync(data)) {
			seat.needKeyframe = true;
			stats.resyncs += 1;

			return;
		}

		if (!isBatch(data)) {
			stats.malformed += 1;

			return;
		}

		if (data.seq !== seat.lastSeq + 1) {
			stats.batchesOutOfOrder += 1;

			return;
		}

		seat.lastSeq = data.seq;
		pending.push({ "seat": seat, "seq": data.seq, "commands": data.commands });
		stats.batchesApplied += 1;
	});

	/** Send `seat` its view; returns that view's hash (computed even when nothing's sent, for the host's summary). */
	function send(seat: Seat): number {
		const visible = visibleUnits(world, seat.team);

		// Nobody subscribed to this team's state yet — a client just seated, its subscription still on the way. Hold
		// its keyframe (the seat's baseline stays put) rather than send it into nothing and make the client resync.
		if (!hub.interested(names.state(seat.team))) {
			stats.held += 1;

			return hashUnits(visible);
		}

		const encoded = new Map(visible.map((unit) => [unit.id, encodeUnit(unit)]));
		const keyframe = seat.needKeyframe || seat.lastTick === null || world.tick - seat.lastKeyframe >= keyframeEvery;
		const update: StateUpdate = {
			"tick": world.tick,
			"baseTick": keyframe ? null : seat.lastTick,
			"ackSeq": seat.appliedSeq,
			"units": keyframe ? [...encoded.values()] : [...encoded].filter(([id, values]) => seat.lastUnits.get(id)?.join() !== values.join()).map(([, values]) => values),
			"removed": keyframe ? [] : [...seat.lastUnits.keys()].filter((id) => !encoded.has(id)),
			"viewHash": hashUnits(visible)
		};

		if (keyframe) {
			seat.lastKeyframe = world.tick;
			seat.needKeyframe = false;
			stats.keyframes += 1;
		} else {
			stats.deltas += 1;
		}

		seat.lastTick = world.tick;
		seat.lastUnits = encoded;
		hub.publish(names.state(seat.team), update);

		return update.viewHash;
	}

	function seatList(): RefereeTick["seats"] {
		return [...seats.values()].map((seat) => ({ "team": seat.team, "peer": seat.peer, "lastSeq": seat.lastSeq }));
	}

	return {
		"world": world,
		"stats": stats,
		"tick": () => {
			for (const { seat, seq, commands } of pending.splice(0)) {
				for (const command of commands) {
					if (applyCommand(world, seat.team, command).ok) {
						stats.commandsApplied += 1;
					} else {
						stats.commandsRejected += 1;
					}
				}

				seat.appliedSeq = seq;
			}

			stepWorld(world);
			stats.ticks += 1;

			const viewHashes: Record<number, number> = {};

			for (const seat of seats.values()) {
				viewHashes[seat.team] = send(seat);
			}

			if (hub.interested(names.refereeTick)) {
				hub.publish(names.refereeTick, { "tick": world.tick, "viewHashes": viewHashes, "seats": seatList(), "stats": { ...stats } } satisfies RefereeTick);
			}
		},
		"seats": seatList,
		"close": () => {
			stopServing();
			unsubscribe();
		}
	};
}
