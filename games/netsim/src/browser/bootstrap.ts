/**
 * The browser runtime's wiring, shared by the page, the instance iframes and the workers.
 *
 * The hub tree (it must stay a tree — hub has no loop protection beyond that):
 *
 *   page ─ referee worker ─┬─ client-0 worker ─ client-0 instance (canvas)
 *                          ├─ client-1 worker ─ client-1 instance
 *                          └─ …
 *
 * The page brokers a MessageChannel per client straight from the referee worker to that client's worker, so the
 * referee's hub holds every client link: it assigns each client its id (LinkOptions.peer) and permissions. The page
 * and the instance iframes aren't hub-linked — the page only hands the iframes their ports.
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

/** page → referee worker: a client's end of its channel, and the id to know it by. */
export interface AttachMessage {
	"type": "netsim-attach";
	"peer": string;
	"port": MessagePort;
}

/** page → instance iframe → its client worker: the channel to the referee, and the id it will be known by. */
export interface PortMessage {
	"type": "netsim-port";
	"id": string;
	"port": MessagePort;
	"bots"?: boolean;
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

/** Match settings from the page URL (`?clients=3&teams=3&seed=1&perTeam=3&bots=0`). */
export function readSettings(search: string): Settings {
	const params = new URLSearchParams(search);
	const number = (name: string, fallback: number): number => {
		const value = Number(params.get(name));

		return Number.isInteger(value) && value > 0 ? value : fallback;
	};
	const clients = number("clients", 3);

	return { "clients": clients, "teams": Math.max(number("teams", clients), clients), "seed": number("seed", 1), "perTeam": number("perTeam", 3), "bots": params.get("bots") !== "0" };
}
