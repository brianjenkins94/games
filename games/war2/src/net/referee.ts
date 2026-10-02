/**
 * The referee: the one authoritative world. It seats clients (`join`), takes their command batches strictly in order,
 * validates each command against the sender's seat as it applies it, and each tick sends every team its view
 * (view.ts). Driven by `tick()` — a timer in a real match, the test loop in a headless one. netsim's referee (W2, see
 * MIGRATION.md), with war2's sim inside.
 *
 * A client is its hub id — the envelope's `from`, which the hub it links to stamps (LinkOptions.peer). Where the
 * referee's own hub holds that link, seating a client also opens the link's permissions to exactly that seat
 * (`seatPermissions`): the referee publishes every team's view, and the hub lets each client receive only its own.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Command } from "../sim/command.ts";
import type { WorldSnapshot } from "../sim/snapshot.ts";
import type { UnitSnapshot } from "../sim/types.ts";
import type { MapInfo, SimWorld } from "../sim/world.ts";
import type { CommandBatch, JoinReply, JoinRequest, RefereeTick, ResyncRequest, StateUpdate } from "./protocol.ts";
import { serve } from "@brianjenkins94/hub";
import { applySnapshot } from "../sim/snapshot.ts";
import { applyCommands } from "../sim/systems/commands.ts";
import { validateCommand } from "../sim/validate.ts";
import { exploredRuns } from "../sim/vision.ts";
import { createSimWorld, stepWorld } from "../sim/world.ts";
import { lobbyPermissions, seatPermissions, subjects } from "./protocol.ts";
import { hashView, teamView } from "./view.ts";

export interface RefereeOptions {
	"hub": Hub;
	"match": string;
	"seed": number;
	/** The map's name (what clients load) and its sim form. */
	"map": string;
	"mapInfo": MapInfo;
	/** How many seats (teams). Default 2. */
	"teams"?: number;
	/** Populate the world before play. */
	"setup"?: (world: SimWorld) => void;
	/** Send a keyframe at least this often (ticks). Default 10. */
	"keyframeEvery"?: number;
	/** After each step: the world, and the commands it applied (validated, each with its issuer's team) — for
	 *  diagnostics that watch the match (src/diag/recorder.ts). Read-only. */
	"observe"?: (world: SimWorld, applied: { "team": number; "command": Command }[]) => void;
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
	/** Commands validateCommand refused. */
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
	/** The last batch actually applied — what updates acknowledge, so a client never sees "acked" before its commands
	 *  show up in the authoritative state. */
	"appliedSeq": number;
	/** What we last sent this team: its tick, each unit as sent (the base of the next delta), and its explored runs. */
	"lastTick": number | null;
	"lastUnits": Map<number, string>;
	"lastExplored": Uint8Array | null;
	"lastKeyframe": number;
	"needKeyframe": boolean;
}

export interface Referee {
	"world": SimWorld;
	"stats": RefereeStats;
	/** Apply the commands that arrived, step the world, and send every seated team its view. */
	"tick": () => void;
	/** Send the keyframes owed — a client just (re)seated, or asking to resync — without stepping the world: what a
	 *  paused match does instead of ticking. */
	"sync": () => void;
	/** Seated teams, for diagnostics. */
	"seats": () => { "team": number; "peer": string; "lastSeq": number }[];
	/** Rewind the match to `snapshot` (an incident's: src/diag/recorder.ts), with `scheduled` commands to apply again at
	 *  their ticks (a command at tick T in the step that makes T) — so stepping on replays it exactly. Every client gets
	 *  a keyframe; its prediction is corrected from it. */
	"restore": (snapshot: WorldSnapshot, scheduled: { "tick": number; "team": number; "command": Command }[]) => void;
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

export function createReferee({ hub, match, seed, map, mapInfo, teams = 2, setup, keyframeEvery = 10, observe }: RefereeOptions): Referee {
	const world = createSimWorld(seed, mapInfo, teams);
	const names = subjects(match);
	/** By token. */
	const seats = new Map<string, Seat>();
	const seatOf = (peer: string | undefined): Seat | undefined => [...seats.values()].find((seat) => seat.peer === peer);
	const pending: { "seat": Seat; "seq": number; "commands": unknown[] }[] = [];
	/** A restored incident's commands, still to apply again: already validated once, applied as they were. */
	let scheduled: { "tick": number; "team": number; "command": Command }[] = [];
	const stats: RefereeStats = { "ticks": 0, "batchesApplied": 0, "batchesOutOfOrder": 0, "unknownSender": 0, "malformed": 0, "commandsApplied": 0, "commandsRejected": 0, "keyframes": 0, "deltas": 0, "held": 0, "resyncs": 0 };

	setup?.(world);

	/** Give `peer` the seat, and open its link (when our hub holds it) to exactly that seat. */
	function seatPeer(seat: Seat, peer: string): JoinReply {
		if (seat.peer !== peer) {
			// Moving the seat to a new link: the old one (if it's still there) goes back to the lobby.
			hub.permit(seat.peer, lobbyPermissions(match, seat.peer));
			seat.peer = peer;
		}

		// Whatever the client had is gone (or never was): its next update is a keyframe.
		seat.needKeyframe = true;
		hub.permit(peer, seatPermissions(match, peer, seat.team));

		return { "team": seat.team, "token": seat.token, "seed": seed, "map": map, "teams": teams, "nextSeq": seat.lastSeq + 1 };
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
		const team = [...Array.from({ "length": teams }).keys()].find((candidate) => !taken.has(candidate));

		if (team === undefined) {
			throw new Error(`match ${match} is full`);
		}

		const seat: Seat = { "team": team, "peer": from, "token": crypto.randomUUID(), "lastSeq": 0, "appliedSeq": 0, "lastTick": null, "lastUnits": new Map(), "lastExplored": null, "lastKeyframe": 0, "needKeyframe": true };

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
		const view = teamView(world, seat.team);
		const runs = exploredRuns(world, seat.team);
		const viewHash = hashView(view, runs);

		// Nobody subscribed to this team's state yet — a client just seated, its subscription still on the way. Hold its
		// keyframe (the seat's baseline stays put) rather than send it into nothing and make the client resync.
		if (!hub.interested(names.state(seat.team))) {
			stats.held += 1;

			return viewHash;
		}

		const encoded = new Map(view.map((unit) => [unit.uid, JSON.stringify(unit)]));
		const explored = world.vision.get(seat.team)?.explored ?? new Uint8Array(0);
		const keyframe = seat.needKeyframe || seat.lastTick === null || world.tick - seat.lastKeyframe >= keyframeEvery;
		const changed = (unit: UnitSnapshot): boolean => seat.lastUnits.get(unit.uid) !== encoded.get(unit.uid);
		const update: StateUpdate = {
			"tick": world.tick,
			"baseTick": keyframe ? null : seat.lastTick,
			"ackSeq": seat.appliedSeq,
			"units": keyframe ? view : view.filter(changed),
			"removed": keyframe ? [] : [...seat.lastUnits.keys()].filter((uid) => !encoded.has(uid)),
			"explored": keyframe ? runs : [...explored.keys()].filter((i) => explored[i] === 1 && seat.lastExplored?.[i] !== 1),
			"viewHash": viewHash
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
		seat.lastExplored = explored.slice();
		hub.publish(names.state(seat.team), update);

		return viewHash;
	}

	function seatList(): RefereeTick["seats"] {
		return [...seats.values()].map((seat) => ({ "team": seat.team, "peer": seat.peer, "lastSeq": seat.lastSeq }));
	}

	return {
		"world": world,
		"stats": stats,
		"tick": () => {
			const applied: { "team": number; "command": Command }[] = [];

			for (const entry of scheduled.filter((candidate) => candidate.tick === world.tick + 1)) {
				applyCommands(world, [entry.command]);
				applied.push({ "team": entry.team, "command": entry.command });
			}

			scheduled = scheduled.filter((candidate) => candidate.tick > world.tick + 1);

			for (const { seat, seq, commands } of pending.splice(0)) {
				for (const command of commands) {
					const result = validateCommand(world, seat.team, command);

					if (result.ok) {
						applyCommands(world, [result.command]);
						applied.push({ "team": seat.team, "command": result.command });
						stats.commandsApplied += 1;
					} else {
						stats.commandsRejected += 1;
					}
				}

				seat.appliedSeq = seq;
			}

			stepWorld(world);
			stats.ticks += 1;
			observe?.(world, applied);

			const viewHashes: Record<number, number> = {};

			for (const seat of seats.values()) {
				viewHashes[seat.team] = send(seat);
			}

			if (hub.interested(names.refereeTick)) {
				hub.publish(names.refereeTick, { "tick": world.tick, "viewHashes": viewHashes, "seats": seatList(), "stats": { ...stats } } satisfies RefereeTick);
			}
		},
		"sync": () => {
			for (const seat of seats.values()) {
				if (seat.needKeyframe || seat.lastTick === null) {
					send(seat);
				}
			}
		},
		"seats": seatList,
		"restore": (snapshot, commands) => {
			applySnapshot(world, snapshot);
			scheduled = commands.filter((entry) => entry.tick > world.tick).map((entry) => structuredClone(entry));
			// Batches taken in but not yet applied are dropped (the replay is the incident's, not live input) — and count as
			// applied, so their clients stop resending them.
			pending.length = 0;

			for (const seat of seats.values()) {
				seat.appliedSeq = seat.lastSeq;
				seat.needKeyframe = true;
			}
		},
		"close": () => {
			stopServing();
			unsubscribe();
		}
	};
}
