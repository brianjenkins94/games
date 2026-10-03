/** Test helper: a war2 referee and N clients, each on its own hub, linked in a star over a virtual network. netsim's
 *  (W2, see MIGRATION.md), with war2's sim: every world — the referee's and each client's prediction — side by side in
 *  this one process. */
import type { Hub } from "@brianjenkins94/hub";
import type { Client, JoinReply, Referee } from "../../src/net/index.ts";
import type { Faults, Network } from "./network.ts";
import type { UnitSnapshot } from "../../src/sim/types.ts";
import type { MapInfo, SimWorld } from "../../src/sim/world.ts";
import { createHub } from "@brianjenkins94/hub";
import { createClient, createReferee, hashView, lobbyPermissions, teamView } from "../../src/net/index.ts";
import { createNetwork } from "./network.ts";
import { CmdType } from "../../src/sim/command.ts";
import { tileCenterFP } from "../../src/sim/components.ts";
import { rngRange } from "../../src/sim/rng.ts";
import { unitTypeId } from "../../src/sim/unitTypes.ts";
import { exploredRuns } from "../../src/sim/vision.ts";
import { spawnUnit } from "../../src/sim/world.ts";

export const TICK_MS = 50;
export const MATCH = "m";
export const SIZE = 24;

/** The test map: SIZE×SIZE open land. */
export const MAP: MapInfo = { "gids": Array.from({ "length": SIZE * SIZE }, () => 1), "mapW": SIZE, "mapH": SIZE, "terrainArr": [0, 0] };
export const loadMap = (name: string): MapInfo => {
	if (name !== "open") {
		throw new Error(`no map ${name}`);
	}

	return MAP;
};

export interface MatchOptions {
	"clients"?: number;
	"teams"?: number;
	/** One Faults for every client link, or one per client. Objects are live: mutate one to change its link. */
	"faults"?: Faults | Faults[];
	"seed"?: number;
	"perTeam"?: number;
	"keyframeEvery"?: number;
}

export interface Match {
	"network": Network;
	"referee": Referee;
	"refereeHub": Hub;
	"clients": Client[];
	/** Each starting client's join reply (team + token), in order. */
	"replies": JoinReply[];
	"hubs": Hub[];
	"faults": Faults[];
	"unlinks": (() => void)[];
	/** One round: the referee ticks, its updates travel, clients tick and send, their batches travel. */
	"tick": () => void;
	"run": (ticks: number, onTick?: () => void) => void;
	/** Add (and link) another client, not yet joined — linked the way a secure host links it: the referee's hub assigns
	 *  its id and starts it with lobby permissions. */
	"addClient": (faults?: Faults, id?: string) => Client;
	/** Link a hub to the referee's the same way (id assigned, lobby permissions), without making a client of it. */
	"linkHub": (hub: Hub, faults?: Faults, peer?: string) => () => void;
}

/** Advance the network and let promise callbacks run, until `promise` settles. */
export async function pump<T>(network: Network, promise: Promise<T>): Promise<T> {
	const state = { "settled": false };
	const done = (): void => {
		state.settled = true;
	};

	promise.then(done, done);

	for (let round = 0; round < 1000 && !state.settled; round += 1) {
		network.advance(5);
		await new Promise((resolve) => { setImmediate(resolve); });
	}

	return promise;
}

export async function startMatch({ "clients": count = 2, teams = Math.max(count, 2), faults = {}, seed = 1, perTeam = 3, keyframeEvery = 10 }: MatchOptions = {}): Promise<Match> {
	const network = createNetwork({ "seed": seed });
	const refereeHub = createHub({ "id": "referee" });
	const footman = unitTypeId("unit-footman");
	const referee = createReferee({
		"hub": refereeHub,
		"match": MATCH,
		"seed": seed,
		"map": "open",
		"mapInfo": MAP,
		"teams": teams,
		"keyframeEvery": keyframeEvery,
		"setup": (world) => {
			for (let team = 0; team < teams; team += 1) {
				for (let index = 0; index < perTeam; index += 1) {
					spawnUnit(world, tileCenterFP(rngRange(world, 0, SIZE)), tileCenterFP(rngRange(world, 0, SIZE)), team, undefined, footman);
				}
			}
		}
	});
	const match: Match = {
		"network": network,
		"referee": referee,
		"refereeHub": refereeHub,
		"clients": [],
		"replies": [],
		"hubs": [],
		"faults": [],
		"unlinks": [],
		"tick": () => {
			referee.tick();
			network.advance(TICK_MS / 2);

			for (const client of match.clients) {
				client.tick();
			}

			network.advance(TICK_MS / 2);
		},
		"run": (ticks, onTick) => {
			for (let index = 0; index < ticks; index += 1) {
				match.tick();
				onTick?.();
			}
		},
		"linkHub": (hub, linkFaults = {}, peer = hub.id) => network.link(refereeHub, hub, linkFaults, { "left": { "peer": peer, "permissions": lobbyPermissions(MATCH, peer) }, "right": { "uplink": true } }),
		"addClient": (linkFaults = {}, id = `client-${match.hubs.length}`) => {
			const hub = createHub({ "id": id });

			match.unlinks.push(match.linkHub(hub, linkFaults));
			match.hubs.push(hub);
			match.faults.push(linkFaults);

			const client = createClient({ "hub": hub, "match": MATCH, "loadMap": loadMap });

			match.clients.push(client);

			return client;
		}
	};

	for (let index = 0; index < count; index += 1) {
		match.addClient(Array.isArray(faults) ? faults[index] : { ...faults });
	}

	match.replies = await pump(network, Promise.all(match.clients.map(async (client) => client.join())));
	// Let the clients' state subscriptions reach the referee before its first tick.
	network.settle();

	return match;
}

/** The referee's view of `team` right now, as the client should have it. */
export function expectedHash(referee: Referee, team: number): number {
	return hashView(teamView(referee.world, team), exploredRuns(referee.world, team));
}

export function isConverged(match: Match, client: Client): boolean {
	return client.viewTick() === match.referee.world.tick && client.viewHash() === expectedHash(match.referee, client.team());
}

/** A sim field of a unit as a view holds it (`world` names the fields: any world's will do). */
export function field(world: SimWorld, unit: UnitSnapshot, name: string): number {
	return unit.values[world.fields.findIndex(([candidate]) => candidate === name)];
}

/** The client's own units in its view. */
export function ownUnits(match: Match, client: Client): UnitSnapshot[] {
	return [...client.view().values()].filter((unit) => field(match.referee.world, unit, "Unit.team") === client.team());
}

/** Seeded random play: each tick, each client moves one of its own units to a random tile, with probability `rate`. */
export function randomOrders(match: Match, seed: number, rate = 0.3): () => void {
	let state = seed;
	const next = (bound: number): number => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;

		return (state >>> 8) % bound;
	};

	return () => {
		for (const client of match.clients) {
			if (next(1000) >= rate * 1000) {
				continue;
			}

			const own = ownUnits(match, client);

			if (own.length > 0) {
				const unit = own[next(own.length)];

				client.command({ "type": CmdType.MOVE, "unitIds": [unit.uid], "txFP": tileCenterFP(next(SIZE)), "tyFP": tileCenterFP(next(SIZE)) });
			}
		}
	};
}
