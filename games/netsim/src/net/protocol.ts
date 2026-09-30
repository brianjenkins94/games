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
import type { WorldConfig } from "../sim/index.ts";

export function subjects(match: string) {
	return {
		"join": `netsim.${match}.join`,
		"commands": `netsim.${match}.commands`,
		"state": (team: number) => `netsim.${match}.state.${team}`
	};
}

// hub's RPC subjects: a call to `name` is published on `$rpc.call.<name>`, its reply on `$rpc.reply.<caller id>`.
const rpcCall = (name: string) => `$rpc.call.${name}`;
const rpcReply = (peer: string) => `$rpc.reply.${peer}`;

/** What a not-yet-seated client (hub id `peer`) may do: ask to join, and hear its own replies. */
export function lobbyPermissions(match: string, peer: string): LinkPermissions {
	return { "publish": [rpcCall(subjects(match).join)], "subscribe": [rpcReply(peer)] };
}

/** What a client seated on `team` may do: join (a reconnect), send commands, and receive its own team's view. */
export function seatPermissions(match: string, peer: string, team: number): LinkPermissions {
	const names = subjects(match);

	return { "publish": [rpcCall(names.join), names.commands], "subscribe": [rpcReply(peer), names.state(team)] };
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
