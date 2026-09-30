/**
 * The wire protocol between the referee and its clients, carried on @brianjenkins94/hub subjects. Everything is plain
 * data (structured-cloneable, JSON-safe), so it crosses any hub transport.
 *
 * - `join` (RPC): a client asks for a seat; the referee answers with its team, a token and the world config.
 * - `commands`: clients → referee. Numbered batches, resent until acknowledged, applied strictly in order — so
 *   commands arrive exactly once, in order, over a lossy link.
 * - `state.<team>`: referee → that team only. Keyframes (the whole visible set) or deltas against the previous
 *   update, each with a hash of the full visible set so the client can prove its view matches.
 */
import type { WorldConfig } from "../sim/index.ts";

export function subjects(match: string) {
	return {
		"join": `netsim.${match}.join`,
		"commands": `netsim.${match}.commands`,
		"state": (team: number) => `netsim.${match}.state.${team}`
	};
}

export interface JoinRequest {
	/** A token from an earlier join: reclaim that seat (a reconnect) rather than take a new one. */
	"token"?: string;
}

export interface JoinReply {
	"team": number;
	/** Identifies this client on the `commands` subject (a batch names its sender by token, never by team). */
	"token": string;
	"config": WorldConfig;
}

export interface CommandBatch {
	"token": string;
	/** 1, 2, 3, … per client. The referee applies batch n only after n − 1. */
	"seq": number;
	"commands": unknown[];
}

/** Sent on `commands` when a client's view has a gap or disagrees with the referee's hash. */
export interface ResyncRequest {
	"token": string;
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
