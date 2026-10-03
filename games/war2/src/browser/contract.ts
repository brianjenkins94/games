/**
 * What the browser runtime's realms say to each other — the pages, the instance iframes and the workers: their
 * messages, subjects and settings (netsim's, W3 — see MIGRATION.md, carrying war2). What a client sees (UnitInfo,
 * InstanceView) is net/view.ts's.
 *
 * One transport for every client: each links to the referee over a WebRTC data channel (hub's offerLink / answerLink and
 * dataChannelTransport), handed straight to the workers at both ends — the host's own player as much as a player in
 * another tab (the two pages signal over the match's lobby: hub's joinLobby) — and the referee's hub holds every client link:
 * it assigns each client its id (LinkOptions.peer; its hello tells the client, whose uplink it is) and permissions.
 * That link carries only the game, both ways. Everything else of a client — its logs, its architecture, its debugging
 * — rides its own tab's tree: page ─ instance ─ client worker. Both of the client worker's links are non-transit, so
 * the trees meet only at the client.
 *
 *   host tab:    page ─┬─ referee worker ┄┬┄ (each client, over its channel)
 *                      └─ player-0 instance ─ player-0 worker
 *   player tab:  page ─ player-1 instance ─ player-1 worker
 *
 * In the host tab that is one loop — page ─ referee ┄ player-0 worker ─ player-0 instance ─ page — where hub wants a
 * tree. It's there on purpose (the host's own player takes the path every other player does) and it's safe because
 * the worker is a leaf on both sides: nothing crosses it from one link to the other, and each link carries one way
 * only what its side is for (client.worker.ts) — the game to the referee, the view and observability to the tab.
 *
 * The metrics plane (observability's reportMetrics: `$sys.metrics.<source>`, once a second) carries what war2's old
 * dashboard charted, and any viewer on the tree draws it (the editor's monitor, debug-mcp's query_metrics): each
 * instance its `fps` and `heap`, each client worker its `units` and `wire`, the referee its `tickMs`, the host page
 * each client's `lag` (ticks behind the referee).
 *
 * The host's controls (inspect, pause / step / speed) are served by the referee worker on the host tab's own tree: no
 * client's link carries them.
 */

import type { UnitInfo } from "../net/view.ts";
import type { UnitSnapshot } from "../sim/types.ts";

export const MATCH = "local";

/** page → referee worker: start the match. */
export interface InitMessage {
	"type": "war2-init";
	"settings": Settings;
}

/** The referee worker's host-only calls (RPC, page → referee): its state, and pausing / stepping / its speed. */
export const REFEREE_INSPECT = `war2.${MATCH}.referee.inspect`;
export const REFEREE_CONTROL = `war2.${MATCH}.referee.control`;
/** The referee's flight recorder (src/diag/recorder.ts), host-only too: its pathologies, incidents, tracks. */
export const REFEREE_DIAG = `war2.${MATCH}.referee.diag`;

export type DiagRequest =
	| { "op": "pathologies" | "incidents" | "commands" }
	| { "op": "incident" | "replay" | "fixture"; "id": string }
	| { "op": "flag"; "label"?: string }
	| { "op": "track"; "uid": number };

export interface RefereeInspection {
	"tick": number;
	"paused": boolean;
	"speed": number;
	"seats": { "team": number; "peer": string; "lastSeq": number }[];
	"stats": Record<string, number>;
	"units": UnitInfo[];
	/** Team → that team's view now (net/view.ts). */
	"views": Record<number, UnitSnapshot[]>;
}

export interface RefereeControl {
	"action": "pause" | "resume" | "step" | "speed";
	/** For `step`: how many ticks (default 1). */
	"ticks"?: number;
	/** For `speed`: the multiplier (0.25–8). */
	"speed"?: number;
}

/** A client worker's answer to `debug.<peer>.inspect`. */
export interface ClientInspection {
	"peer": string;
	"team": number | undefined;
	"viewTick": number;
	"viewHash": number;
	"inSync": boolean;
	"stats": Record<string, number>;
	"view": UnitSnapshot[];
	"predicted": UnitInfo[];
}

/** page → referee worker: the data channel a client links over (transferred: hub's offerLink), and the id to know it by. */
export interface AttachMessage {
	"type": "war2-attach";
	"peer": string;
	"channel": RTCDataChannel;
}

/** page → instance iframe → its client worker: the data channel to the referee (transferred on, as it arrives). On
 *  every load of the iframe, so a reloaded instance gets a fresh link (and the referee drops the old one). */
export interface PortMessage {
	"type": "war2-port";
	"channel": RTCDataChannel;
	"bots"?: boolean;
	/** The seat token from this instance's earlier join in this match, if any: rejoin that seat. */
	"token"?: string;
}

/** Subjects of a client's own tab (client worker ⇄ its instance page), and its debugging. */
export function instanceSubjects(id: string) {
	return {
		/** worker → page: what to draw (InstanceView). */
		"view": `war2.${MATCH}.view.${id}`,
		/** page → worker: a click, in world coordinates (InstanceInput). */
		"input": `war2.${MATCH}.input.${id}`,
		/** Debugging the client (RPC), from its own tab: `inspect`, `command`. */
		"debug": (op: string) => `war2.${MATCH}.debug.${id}.${op}`
	};
}

/** Where an instance keeps its seat token across a reload: per match (a new page is a new match), per client. */
export function seatKey(match: string, id: string): string {
	return `war2.${match}.${id}.token`;
}

/** page → its client worker: the player's selection (for the worker's view and tools), or a command to give — which
 *  the worker checks against its prediction (validate.ts) before predicting and sending it. */
export type InstanceInput =
	| { "action": "select"; "uids": number[] }
	| { "action": "command"; "command": unknown };

export interface Settings {
	"clients": number;
	"teams": number;
	"seed": number;
	"perTeam": number;
	"bots": boolean;
	/** A built-in map (`open`, `arena`) or the mirror's (`ladder/Plains of snow BNE`): maps.ts. */
	"map": string;
}

/** Match settings from the page URL (`?clients=2&teams=2&seed=1&perTeam=4&bots=0&map=arena`); `defaults` for what it
 *  omits. The default map is the one the old war2 booted on. */
export function readSettings(search: string, defaults: { "clients"?: number; "teams"?: number } = {}): Settings {
	const params = new URLSearchParams(search);
	const number = (name: string, fallback: number): number => {
		const value = Number(params.get(name));

		return Number.isInteger(value) && value > 0 ? value : fallback;
	};
	const clients = number("clients", defaults.clients ?? 2);

	return { "clients": clients, "teams": Math.max(number("teams", defaults.teams ?? clients), clients), "seed": number("seed", 1), "perTeam": number("perTeam", 4), "bots": params.get("bots") !== "0", "map": params.get("map") ?? "ladder/Plains of snow BNE" };
}
