/**
 * The browser runtime's wiring, shared by the pages, the instance iframes and the workers.
 *
 * The hub tree (it must stay a tree — hub has no loop protection beyond that):
 *
 *   page ─ referee worker ─┬─ client-0 worker ─ client-0 instance (canvas)
 *                          ├─ client-1 worker ─ client-1 instance
 *                          └─ …
 *
 * The page brokers a MessageChannel per client straight from the referee worker to that client's worker, so the
 * referee's hub holds every client link: it assigns each client its id (LinkOptions.peer; its hello tells the client)
 * and permissions. In the
 * harness (index.html) the page and the instance iframes aren't hub-linked — the page only hands the iframes their
 * ports.
 *
 * Players in separate tabs (play.html): the host's tab is the tree above with one instance; each other player's tab is
 * its own tree — its page, its instance, its client worker — and the client worker also links to the host's referee,
 * over a BroadcastChannel the lobby named (lobby.ts; channelTransport). Both of the client worker's links are
 * non-transit, so the two trees meet only at the client: neither sees the other's traffic, and the host's link carries only the game (the referee
 * doesn't observe a remote client — PeerOptions.observed; the client confines the host — hostPermissions).
 *
 *   host tab:    page ─ referee worker ─┬─ player-0 worker ─ player-0 instance
 *                                       └┄ (remote)
 *   player tab:  page ─ player-1 instance ─ player-1 worker ┄┘
 */
import type { WorldConfig } from "../sim/index.ts";

/** A hub transport over the BroadcastChannel named `name` — from anywhere: a page or a worker. `close` also closes the
 *  channel. How players in other tabs link (lobby.ts names the channel). BroadcastChannel reaches every same-origin
 *  context that opens the same name, so it's private only in that its name is unguessable — same-origin pages are
 *  trusted. */
export function channelTransport(name: string): { "send": (message: unknown) => void; "listen": (onMessage: (message: unknown) => void) => () => void; "close": () => void } {
	const channel = new BroadcastChannel(name);

	return {
		"send": (message) => { channel.postMessage(message); },
		"listen": (onMessage) => {
			const handler = (event: MessageEvent): void => { onMessage(event.data); };

			channel.addEventListener("message", handler);

			return () => { channel.removeEventListener("message", handler); };
		},
		"close": () => { channel.close(); }
	};
}

export const MATCH = "local";
export const TICK_MS = 50;

/** page → referee worker: start the match. */
export interface InitMessage {
	"type": "netsim-init";
	"config": WorldConfig;
	"perTeam": number;
	/** The page's hub id when debugging is on: clients' links then let it debug them (debugPermissions). */
	"debugHost"?: string;
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

/** page → referee worker: a client's end of its channel, and the id to know it by. */
export interface AttachMessage {
	"type": "netsim-attach";
	"peer": string;
	/** A client of this page's: its end of a MessageChannel. */
	"port"?: MessagePort;
	/** A player in another tab: the BroadcastChannel its client links over (channelTransport). Its link carries only
	 *  the game — no observability; its own tab observes it. */
	"channel"?: string;
}

/** page → instance iframe → its client worker: the channel to the referee (who the client is, the referee tells it —
 *  hub's knownAs). Sent on every load of the iframe, so a reloaded instance gets a fresh channel (and the referee drops
 *  the old one). */
export interface PortMessage {
	"type": "netsim-port";
	/** The channel to the referee: a MessageChannel's end (the referee is in this tab)… */
	"port"?: MessagePort;
	/** …or a BroadcastChannel's name (it's in the host's tab: this is a remote client — see `remote`). */
	"channel"?: string;
	"bots"?: boolean;
	/** The seat token from this instance's earlier join in this match, if any: rejoin that seat. */
	"token"?: string;
	/** The referee is in another tab (the host's): link to it non-transit and confined (hostPermissions), and to this
	 *  instance non-transit too, so the two tabs' trees don't join; and link the instance up to its page. Set with
	 *  `channel`. */
	"remote"?: boolean;
	/** For a remote client: the host page's hub id, when this player has debugging on — the host may then debug it. */
	"debugHost"?: string;
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
