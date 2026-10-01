/**
 * The wire protocol between the referee and its clients, carried on @brianjenkins94/hub subjects. Everything is plain
 * data (structured-cloneable, JSON-safe), so it crosses any hub transport.
 *
 * - `join` (RPC): a client asks for a seat; the referee answers with its team, a token and the world config.
 * - `commands`: clients → referee. Numbered batches, resent until acknowledged, applied strictly in order — so
 *   commands arrive exactly once, in order, over a lossy link.
 * - `state.<team>`: referee → that team only. Keyframes (the whole visible set) or deltas against the previous
 *   update, each with a hash of the full visible set so the client can prove its view matches.
 *
 * Who a message is from is the hub envelope's `from`, which the hub a client links to stamps with the id it assigned
 * that client (LinkOptions.peer) — so a client can't speak for another. That same hub confines what the client may
 * send and receive with link permissions: `lobbyPermissions` until it's seated, then `seatPermissions` (its own
 * team's state, nothing else) — so fog of war holds even against a client that subscribes to everything.
 */
import type { LinkPermissions } from "@brianjenkins94/hub";
import { rpcCallSubject, rpcReplySubject } from "@brianjenkins94/hub";
import type { WorldConfig } from "../sim/index.ts";

export function subjects(match: string) {
	return {
		"join": `netsim.${match}.join`,
		"commands": `netsim.${match}.commands`,
		"state": (team: number) => `netsim.${match}.state.${team}`,
		/** Each client's own diagnostics (ClientDiag), published by that client only. */
		"diag": (peer: string) => `netsim.${match}.diag.${peer}`,
		/** The referee's per-tick summary (RefereeTick) — for the host, never a client. */
		"refereeTick": `netsim.${match}.referee.tick`,
		/** Debugging a client (RPC): `inspect`, `command` — served in its own tab's tree (its page reaches it through its
		 *  instance), never across the referee link. */
		"debug": (peer: string, op: string) => `netsim.${match}.debug.${peer}.${op}`
	};
}

/** Every client's link, whatever its seat: report its own diagnostics, hear its own replies. Nothing else crosses — not
 *  its observability or its debugging, which ride its own tab's tree (its instance page). */
function common(match: string, peer: string): Required<LinkPermissions> {
	return { "publish": [subjects(match).diag(peer)], "subscribe": [rpcReplySubject(peer)] };
}

/** What a not-yet-seated client (hub id `peer`) may do: ask to join, hear its own replies, report its own
 *  diagnostics. */
export function lobbyPermissions(match: string, peer: string): LinkPermissions {
	const names = subjects(match);
	const shared = common(match, peer);

	return { "publish": [rpcCallSubject(names.join), ...shared.publish], "subscribe": shared.subscribe };
}

/** What a client seated on `team` may do: everything in the lobby, plus send commands and receive its own team's
 *  view. */
export function seatPermissions(match: string, peer: string, team: number): LinkPermissions {
	const names = subjects(match);
	const shared = common(match, peer);

	return { "publish": [rpcCallSubject(names.join), names.commands, ...shared.publish], "subscribe": [names.state(team), ...shared.subscribe] };
}

/**
 * The other direction — what a client's own hub lets its referee do (the referee is another tab's, the host's, or in
 * its own tab: either way, not its tree): send the client its team's state and its RPC replies, and hear only the
 * client's join, commands and diagnostics. Nothing of the client's own tab — its logs, its debugging, its instance
 * page's input — crosses, whatever the referee subscribes to or sends.
 */
export function hostPermissions(match: string, peer: string): Required<LinkPermissions> {
	const names = subjects(match);

	return {
		"publish": [`netsim.${match}.state.*`, rpcReplySubject(peer)],
		"subscribe": [rpcCallSubject(names.join), names.commands, names.diag(peer)]
	};
}

export interface JoinRequest {
	/** A token from an earlier join: reclaim that seat (a reconnect) rather than take a new one. */
	"token"?: string;
}

export interface JoinReply {
	"team": number;
	/** Reclaims this seat from another link after a reconnect (see JoinRequest). Everything else identifies the client
	 *  by its hub id. */
	"token": string;
	"config": WorldConfig;
	/** The seat's next command batch number. A client reclaiming a seat (a reloaded page, a fresh client) carries on
	 *  from here: the referee takes batches strictly in sequence, so starting again at 1 would be ignored forever. */
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
	/** Team → hashUnits of what that team can see this tick. */
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
	/** Units (UNIT_FIELDS-encoded) that are new or changed since `baseTick` — or, in a keyframe, all of them. */
	"units": number[][];
	/** Units that left this team's view since `baseTick`. */
	"removed": number[];
	/** hashUnits of the complete visible set at `tick`, in id order. */
	"viewHash": number;
}
