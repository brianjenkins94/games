/**
 * The wire protocol between war2's referee and its clients, carried on @brianjenkins94/hub subjects — netsim's
 * protocol (W2, see MIGRATION.md), carrying war2's world. Everything is plain data (structured-cloneable, JSON-safe),
 * so it crosses any hub transport.
 *
 * - `join` (RPC): a client asks for a seat; the referee answers with its team, a token, and the match (seed + map name:
 *   the client loads the same map).
 * - `commands`: clients → referee. Numbered batches, resent until acknowledged, applied strictly in order — so commands
 *   arrive exactly once, in order, over a lossy link. Each command is validated (sim/validate.ts) as it's applied.
 * - `state.<team>`: referee → that team only. Keyframes (the whole view) or deltas against the previous update, each
 *   with a hash of the whole view so the client can prove its copy matches.
 *
 * Who a message is from is the hub envelope's `from`, which the hub a client links to stamps with the id it assigned
 * that client (LinkOptions.peer) — so a client can't speak for another. That same hub confines what the client may send
 * and receive with link permissions: `lobbyPermissions` until it's seated, then `seatPermissions` (its own team's
 * state, nothing else) — so fog of war holds even against a client that subscribes to everything.
 */
import type { LinkPermissions } from "@brianjenkins94/hub";
import type { UnitSnapshot } from "../sim/types.ts";
import { rpcCallSubject, rpcReplySubject } from "@brianjenkins94/hub";

export function subjects(match: string) {
	return {
		"join": `war2.${match}.join`,
		"commands": `war2.${match}.commands`,
		"state": (team: number) => `war2.${match}.state.${team}`,
		/** Each client's own diagnostics (ClientDiag), published by that client only. */
		"diag": (peer: string) => `war2.${match}.diag.${peer}`,
		/** The referee's per-tick summary (RefereeTick) — for the host, never a client. */
		"refereeTick": `war2.${match}.referee.tick`
	};
}

/** Every client's link, whatever its seat: report its own diagnostics, hear its own replies. */
function common(match: string, peer: string): Required<LinkPermissions> {
	return { "publish": [subjects(match).diag(peer)], "subscribe": [rpcReplySubject(peer)] };
}

/** What a not-yet-seated client (hub id `peer`) may do: ask to join, hear its own replies, report its own diagnostics. */
export function lobbyPermissions(match: string, peer: string): LinkPermissions {
	const shared = common(match, peer);

	return { "publish": [rpcCallSubject(subjects(match).join), ...shared.publish], "subscribe": shared.subscribe };
}

/** What a client seated on `team` may do: everything in the lobby, plus send commands and receive its own team's view. */
export function seatPermissions(match: string, peer: string, team: number): LinkPermissions {
	const names = subjects(match);
	const shared = common(match, peer);

	return { "publish": [rpcCallSubject(names.join), names.commands, ...shared.publish], "subscribe": [names.state(team), ...shared.subscribe] };
}

/**
 * The other direction — what a client's own hub lets its referee do (the referee is another tab's, the host's, or in
 * its own tab: either way, not its tree): send the client its team's state and its RPC replies, and hear only the
 * client's join, commands and diagnostics.
 */
export function hostPermissions(match: string, peer: string): Required<LinkPermissions> {
	const names = subjects(match);

	return {
		"publish": [`war2.${match}.state.*`, rpcReplySubject(peer)],
		"subscribe": [rpcCallSubject(names.join), names.commands, names.diag(peer)]
	};
}

export interface JoinRequest {
	/** A token from an earlier join: reclaim that seat (a reconnect) rather than take a new one. */
	"token"?: string;
}

export interface JoinReply {
	"team": number;
	/** Reclaims this seat from another link after a reconnect (see JoinRequest). */
	"token": string;
	/** The match: its seed, and its map's name (the client loads the map itself). */
	"seed": number;
	"map": string;
	/** How many teams the match has. */
	"teams": number;
	/** The seat's next command batch number: a client reclaiming a seat carries on from here. */
	"nextSeq": number;
}

export interface CommandBatch {
	/** 1, 2, 3, … per client. The referee applies batch n only after n − 1. */
	"seq": number;
	"commands": unknown[];
}

/** Sent on `commands` when a client's view has a gap or disagrees with the referee's hash. */
export interface ResyncRequest {
	"resync": true;
}

/** A client's diagnostics, on its own `diag.<peer>` subject — enough for a host to check it against the referee. */
export interface ClientDiag {
	"peer": string;
	"team": number | undefined;
	"viewTick": number;
	"viewHash": number;
	"stats": Record<string, number>;
}

/** The referee's summary after each tick: every seated team's view hash, to check each client's `ClientDiag`. */
export interface RefereeTick {
	"tick": number;
	/** Team → the hash of what that team was sent this tick. */
	"viewHashes": Record<number, number>;
	"seats": { "team": number; "peer": string; "lastSeq": number }[];
	"stats": Record<string, number>;
}

export interface StateUpdate {
	"tick": number;
	/** The tick of the update this delta applies on top of; null for a keyframe. */
	"baseTick": number | null;
	/** The highest command batch from this client that this update's state already includes. */
	"ackSeq": number;
	/** Units (view.ts) that are new or changed since `baseTick` — or, in a keyframe, all of them. */
	"units": UnitSnapshot[];
	/** Stable ids of units that left this team's view since `baseTick`. */
	"removed": number[];
	/** What the team has explored: in a keyframe, all of it as runs ([start, length, …] over flat tile indices); in a
	 *  delta, the tiles newly explored since `baseTick`. */
	"explored": number[];
	/** hashView of the complete view at `tick`. */
	"viewHash": number;
}
