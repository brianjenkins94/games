/**
 * The browser runtime's wiring, shared by the pages, the instance iframes and the workers.
 *
 * One transport for every client: each links to the referee over a BroadcastChannel (hub's channelTransport) — a
 * client of the host's own page as much as a player in another tab (the lobby names that one's channel: lobby.ts) —
 * and the referee's hub holds every client link: it assigns each client its id (LinkOptions.peer; its hello tells the
 * client, whose uplink it is) and permissions. That link carries only the game, both ways (lobby / seat permissions
 * on the referee's side, hostPermissions on the client's). Everything else of a client — its logs, its architecture,
 * its debugging — rides its own tab's tree: page ─ instance ─ client worker, the instance naming its worker (the edge
 * names). Both of the client worker's links are non-transit, so the trees meet only at the client.
 *
 *   host tab:    page ─┬─ referee worker ┄┬┄ (each client, over its channel)
 *                      └─ player-0 instance ─ player-0 worker
 *   player tab:  page ─ player-1 instance ─ player-1 worker
 *
 * (Each tree must stay a tree — hub has no loop protection beyond that.) Same-origin tabs trust each other (lobby.ts);
 * a shipped game's players link over WebRTC instead.
 */
import type { WorldConfig } from "../sim/index.ts";

export const MATCH = "local";
export const TICK_MS = 50;

/** page → referee worker: start the match. */
export interface InitMessage {
	"type": "netsim-init";
	"config": WorldConfig;
	"perTeam": number;
}

/** The referee worker's host-only calls (RPC, page → referee): its state, and pausing / stepping it. */
export const REFEREE_INSPECT = `netsim.${MATCH}.referee.inspect`;
export const REFEREE_CONTROL = `netsim.${MATCH}.referee.control`;

export interface RefereeInspection {
	"tick": number;
	"paused": boolean;
	"seats": { "team": number; "peer": string; "lastSeq": number }[];
	"stats": Record<string, number>;
	/** Every unit, UNIT_FIELDS-encoded. */
	"units": number[][];
	/** Team → what that team can see now, UNIT_FIELDS-encoded. */
	"visible": Record<number, number[][]>;
}

export interface RefereeControl {
	"action": "pause" | "resume" | "step";
	/** For `step`: how many ticks (default 1). */
	"ticks"?: number;
}

/** A client worker's answer to `debug.<peer>.inspect`. */
export interface ClientInspection {
	"peer": string;
	"team": number | undefined;
	"viewTick": number;
	"viewHash": number;
	"inSync": boolean;
	"stats": Record<string, number>;
	"units": number[][];
	"predicted": number[][];
}

/** page → referee worker: the BroadcastChannel a client links over (hub's channelTransport), and the id to know it by. */
export interface AttachMessage {
	"type": "netsim-attach";
	"peer": string;
	"channel": string;
}

/** page → instance iframe → its client worker: the channel to the referee (who the client is, the referee tells it —
 *  hub's knownAs). Sent on every load of the iframe, so a reloaded instance gets a fresh channel (and the referee drops
 *  the old one). */
export interface PortMessage {
	"type": "netsim-port";
	/** The BroadcastChannel to the referee (in this tab, or the host's). */
	"channel": string;
	"bots"?: boolean;
	/** The seat token from this instance's earlier join in this match, if any: rejoin that seat. */
	"token"?: string;
}

/** A fresh, unguessable BroadcastChannel name for `peer`'s link to the referee of match `match`. */
export function linkChannel(match: string, peer: string): string {
	return `netsim.${match}.link.${peer}.${crypto.randomUUID()}`;
}

/** Instance-local subjects (client worker ⇄ its instance page). */
export function instanceSubjects(id: string) {
	return {
		/** worker → page: what to draw (InstanceView). */
		"view": `netsim.${MATCH}.view.${id}`,
		/** page → worker: a click, in world coordinates (InstanceInput). */
		"input": `netsim.${MATCH}.input.${id}`
	};
}

/** Where an instance keeps its seat token across a reload: per match (a new page is a new match), per client. */
export function seatKey(match: string, id: string): string {
	return `netsim.${match}.${id}.token`;
}

export interface InstanceView {
	"id": string;
	"team": number | undefined;
	"viewTick": number;
	"inSync": boolean;
	"config": WorldConfig | undefined;
	/** The authoritative view, UNIT_FIELDS-encoded. */
	"units": number[][];
	/** This team's units as predicted locally, UNIT_FIELDS-encoded. */
	"predicted": number[][];
	"selected": number | undefined;
	"stats": Record<string, number>;
	/** The seat token, for the instance to keep across a reload. State, sent with every view — not a one-off event: a
	 *  publish right after the worker links can be lost (its page's interest arrives after the hello round trip). */
	"token": string | undefined;
}

export interface InstanceInput {
	"action": "select" | "move";
	"x": number;
	"y": number;
}

export interface Settings {
	"clients": number;
	"teams": number;
	"seed": number;
	"perTeam": number;
	"bots": boolean;
}

/** Match settings from the page URL (`?clients=3&teams=3&seed=1&perTeam=3&bots=0`); `defaults` for what it omits. */
export function readSettings(search: string, defaults: { "clients"?: number; "teams"?: number } = {}): Settings {
	const params = new URLSearchParams(search);
	const number = (name: string, fallback: number): number => {
		const value = Number(params.get(name));

		return Number.isInteger(value) && value > 0 ? value : fallback;
	};
	const clients = number("clients", defaults.clients ?? 3);

	return { "clients": clients, "teams": Math.max(number("teams", defaults.teams ?? clients), clients), "seed": number("seed", 1), "perTeam": number("perTeam", 3), "bots": params.get("bots") !== "0" };
}
