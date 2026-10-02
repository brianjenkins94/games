/**
 * The browser runtime's wiring, shared by the pages, the instance iframes and the workers — netsim's (W3, see
 * MIGRATION.md), carrying war2.
 *
 * One transport for every client: each links to the referee over a WebRTC data channel (rtc.ts; hub's
 * dataChannelTransport), handed straight to the workers at both ends — the host's own player as much as a player in
 * another tab (the two pages signal over the match's lobby: lobby.ts) — and the referee's hub holds every client link:
 * it assigns each client its id (LinkOptions.peer; its hello tells the client, whose uplink it is) and permissions.
 * That link carries only the game, both ways. Everything else of a client — its logs, its architecture, its debugging
 * — rides its own tab's tree: page ─ instance ─ client worker. Both of the client worker's links are non-transit, so
 * the trees meet only at the client.
 *
 *   host tab:    page ─┬─ referee worker ┄┬┄ (each client, over its channel)
 *                      └─ player-0 instance ─ player-0 worker
 *   player tab:  page ─ player-1 instance ─ player-1 worker
 *
 * The host's controls (inspect, pause / step / speed) are served by the referee worker on the host tab's own tree: no
 * client's link carries them.
 */
import type { UnitSnapshot } from "../sim/types.ts";
import { createComponents, simFields } from "../sim/components.ts";
import { unitTypeName } from "../sim/unitTypes.ts";

export const MATCH = "local";
export const TICK_MS = 50;

/** page → referee worker: start the match. */
export interface InitMessage {
	"type": "war2-init";
	"settings": Settings;
}

/** The referee worker's host-only calls (RPC, page → referee): its state, and pausing / stepping / its speed. */
export const REFEREE_INSPECT = `war2.${MATCH}.referee.inspect`;
export const REFEREE_CONTROL = `war2.${MATCH}.referee.control`;

/** A unit as the tools and the debug canvas show it: by name, with what matters to look at. */
export interface UnitInfo {
	"uid": number;
	"team": number;
	"type": string;
	/** Fixed-point centre. */
	"x": number;
	"y": number;
	"moving": boolean;
	/** Facing, 0–7 clockwise from north. */
	"dir": number;
	/** Its move target, while it has one (absent for an enemy: the view doesn't carry it). */
	"target"?: [number, number];
	"building"?: { "w": number; "h": number; "buildLeft": number };
	/** An own unit's queue state (an enemy's isn't in the view): shift-queued orders, a building's production
	 *  (product type names) and rally point. */
	"orders"?: UnitSnapshot["orders"];
	"production"?: { "queue": string[]; "ticksLeft": number; "ticksTotal": number };
	"rally"?: [number, number];
}

/** The sim's field names, in order (every world's are the same): how a UnitSnapshot's values are read. */
const FIELDS = simFields(createComponents()).map(([name]) => name);
const INDEX = new Map(FIELDS.map((name, index) => [name, index]));

/** A field of a unit snapshot, by name. */
export function valueOf(unit: UnitSnapshot, name: string): number {
	return unit.values[INDEX.get(name)];
}

export function describe(unit: UnitSnapshot): UnitInfo {
	const info: UnitInfo = { "uid": unit.uid, "team": valueOf(unit, "Unit.team"), "type": unitTypeName(valueOf(unit, "Unit.type")), "x": valueOf(unit, "Position.x"), "y": valueOf(unit, "Position.y"), "moving": valueOf(unit, "UnitAnim.moving") === 1, "dir": valueOf(unit, "UnitAnim.dir") };

	if (valueOf(unit, "MoveTarget.active") === 1 && (valueOf(unit, "MoveTarget.tx") !== 0 || valueOf(unit, "MoveTarget.ty") !== 0)) {
		info.target = [valueOf(unit, "MoveTarget.tx"), valueOf(unit, "MoveTarget.ty")];
	}

	if (valueOf(unit, "Building.fw") > 0) {
		info.building = { "w": valueOf(unit, "Building.fw"), "h": valueOf(unit, "Building.fh"), "buildLeft": valueOf(unit, "Building.buildLeft") };
	}

	if (unit.orders !== undefined) {
		info.orders = unit.orders;
	}

	if (unit.prod !== undefined) {
		info.production = { "queue": unit.prod.queue.map(unitTypeName), "ticksLeft": unit.prod.ticksLeft, "ticksTotal": unit.prod.ticksTotal };
	}

	if (unit.rally !== undefined) {
		info.rally = [unit.rally.txFP, unit.rally.tyFP];
	}

	return info;
}

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

/** page → referee worker: the data channel a client links over (transferred: rtc.ts), and the id to know it by. */
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

export interface InstanceView {
	"id": string;
	"team": number | undefined;
	"viewTick": number;
	"inSync": boolean;
	/** The match's map, by name (the instance loads it itself). */
	"map": string | undefined;
	/** The authoritative view. */
	"units": UnitInfo[];
	/** This team's units as predicted locally. */
	"predicted": UnitInfo[];
	/** What this team has explored, as runs ([start, length, …] over flat tile indices). */
	"explored": number[];
	"selected": number[];
	"stats": Record<string, number>;
	/** The seat token, for the instance to keep across a reload. State, sent with every view. */
	"token": string | undefined;
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
