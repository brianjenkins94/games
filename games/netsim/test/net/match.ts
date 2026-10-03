/** Test helper: a referee and N clients, each on its own hub, linked in a star over a virtual network. */
import type { Faults, Hub, Network } from "@brianjenkins94/hub";
import type { Client, JoinReply, Referee } from "../../src/net/index.ts";
import type { WorldConfig } from "../../src/sim/index.ts";
import { createHub, createNetwork, matches } from "@brianjenkins94/hub";
import { createClient, createReferee, lobbyPermissions } from "../../src/net/index.ts";
import { createRng, hashUnits, nextInt, nextU32, spawnUnit, tiles, visibleUnits } from "../../src/sim/index.ts";

export const TICK_MS = 50;

const GAME_TRAFFIC = ["netsim.*.commands", "netsim.*.state.*"];

/** hub's virtual network as netsim's tests use it: faults on the game's traffic only (commands, state), from netsim's
 *  own seeded generator, so a run's losses and reorderings repeat exactly. */
export function gameNetwork(seed = 1): Network {
	const rng = createRng(seed);

	return createNetwork({ "random": () => nextU32(rng), "faulty": (subject) => GAME_TRAFFIC.some((pattern) => matches(pattern, subject)) });
}
export const MATCH = "m";

export interface MatchOptions {
	"clients"?: number;
	"config"?: Partial<WorldConfig>;
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

export async function startMatch({ "clients": count = 2, config = {}, faults = {}, seed = 1, perTeam = 3, keyframeEvery = 10 }: MatchOptions = {}): Promise<Match> {
	const network = gameNetwork(seed);
	const refereeHub = createHub({ "id": "referee" });
	const teams = config.teams ?? Math.max(count, 2);
	const referee = createReferee({
		"hub": refereeHub,
		"match": MATCH,
		"config": { "width": 24, "height": 24, "teams": teams, "seed": seed, "speed": 125, "sight": tiles(5), ...config },
		"keyframeEvery": keyframeEvery,
		"setup": (world) => {
			for (let team = 0; team < world.config.teams; team += 1) {
				for (let index = 0; index < perTeam; index += 1) {
					spawnUnit(world, team, nextInt(world.rng, 0, tiles(world.config.width)), nextInt(world.rng, 0, tiles(world.config.height)));
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

			const client = createClient({ "hub": hub, "match": MATCH });

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
	return hashUnits(visibleUnits(referee.world, team));
}

export function isConverged(match: Match, client: Client): boolean {
	return client.viewTick() === match.referee.world.tick && client.viewHash() === expectedHash(match.referee, client.team());
}

/** Seeded random play: each tick, each client moves one of its own units somewhere, with probability `rate`. */
export function randomOrders(match: Match, seed: number, rate = 0.3): () => void {
	const rng = createRng(seed);
	const size = tiles(match.referee.world.config.width);

	return () => {
		for (const client of match.clients) {
			if (nextInt(rng, 0, 1000) >= rate * 1000) {
				continue;
			}

			const own = [...client.view().values()].filter((unit) => unit.team === client.team());

			if (own.length > 0) {
				const unit = own[nextInt(rng, 0, own.length)];

				client.command({ "type": "move", "units": [unit.id], "x": nextInt(rng, 0, size), "y": nextInt(rng, 0, size) });
			}
		}
	};
}
