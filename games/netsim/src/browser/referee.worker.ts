/** The referee, in its own worker: the page's child in the hub tree, and the hub every client links to. */
import type { Referee } from "../net/index.ts";
import type { AttachMessage, InitMessage, RefereeControl, RefereeInspection } from "./bootstrap.ts";
import { channelTransport, createHub, portTransport, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { createReferee, lobbyPermissions } from "../net/index.ts";
import { encodeUnit, nextInt, spawnUnit, tiles, visibleUnits } from "../sim/index.ts";
import { MATCH, REFEREE_CONTROL, REFEREE_INSPECT, TICK_MS } from "./bootstrap.ts";

const hub = createHub({ "id": "referee" });
const { log } = observe(hub);

hub.link(portTransport(globalThis));

// What link permissions refuse is worth seeing: a client asking for another team's view, or sending what it may not.
hub.tap((event) => {
	if (event.type === "deny" && !event.envelope.subject.startsWith("$sys.")) {
		log.warn("denied", { "peer": event.link.peerId, "direction": event.direction, "subject": event.envelope.subject });
	}
});

let debugHost: string | undefined;
/** Each client's current link, by peer id: a reloaded instance attaches again, replacing its dead one. */
const links = new Map<string, () => void>();
/** Players in other tabs: their links carry only the game (their own tabs observe them). */
const remote = new Set<string>();
const observed = (peer: string): boolean => !remote.has(peer);
let paused = false;
let current: Referee | undefined;

// The page's calls (its link is the trusted one; clients may not publish these). Debugging, when the page enables it.
serve(hub, REFEREE_INSPECT, (): RefereeInspection | undefined => {
	if (current === undefined) {
		return undefined;
	}

	const { world } = current;
	const seats = current.seats();

	return {
		"tick": world.tick,
		"paused": paused,
		"seats": seats,
		"stats": { ...current.stats },
		"units": [...world.units.values()].map(encodeUnit),
		"visible": Object.fromEntries(seats.map((seat) => [seat.team, visibleUnits(world, seat.team).map(encodeUnit)]))
	};
});
serve(hub, REFEREE_CONTROL, (args) => {
	const { action, ticks = 1 } = args as RefereeControl;

	if (current === undefined) {
		throw new Error("the match hasn't started");
	}

	if (action === "step") {
		paused = true;

		for (let index = 0; index < Math.max(1, Math.min(ticks, 1000)); index += 1) {
			current.tick();
		}
	} else {
		paused = action === "pause";
	}

	log.info("control", { "action": action, "tick": current.world.tick });

	return { "tick": current.world.tick, "paused": paused };
});

globalThis.addEventListener("message", (event: MessageEvent<InitMessage | AttachMessage | undefined>) => {
	const message = event.data;

	if (message?.type === "netsim-init") {
		debugHost = message.debugHost;

		const referee = createReferee({
			"hub": hub,
			"match": MATCH,
			"config": message.config,
			"debugHost": debugHost,
			"observed": observed,
			"setup": (world) => {
				for (let team = 0; team < world.config.teams; team += 1) {
					for (let index = 0; index < message.perTeam; index += 1) {
						spawnUnit(world, team, nextInt(world.rng, 0, tiles(world.config.width)), nextInt(world.rng, 0, tiles(world.config.height)));
					}
				}
			}
		});

		let seated = "";

		current = referee;

		log.info("referee started", { "teams": message.config.teams, "units": referee.world.units.size });
		setInterval(() => {
			if (paused) {
				return;
			}

			referee.tick();

			const seats = referee.seats().map((seat) => `${seat.peer}=${seat.team}`).join(",");

			if (seats !== seated) {
				seated = seats;
				log.info("seats", { "seats": seats });
			}
		}, TICK_MS);
	} else if (message?.type === "netsim-attach") {
		const replaced = links.get(message.peer);
		const isRemote = message.channel !== undefined;

		replaced?.();

		if (isRemote) {
			remote.add(message.peer);
		} else {
			remote.delete(message.peer);
		}

		// A player in another tab links over a BroadcastChannel (closed with its link); ours over a MessageChannel.
		const channel = message.channel === undefined ? undefined : channelTransport(message.channel);
		const unlink = hub.link(channel ?? portTransport(message.port!), { "peer": message.peer, "permissions": lobbyPermissions(MATCH, message.peer, { "debugHost": debugHost, "observed": observed(message.peer) }) });

		links.set(message.peer, () => {
			unlink();
			channel?.close();
		});
		log.info(replaced === undefined ? "client linked" : "client relinked", { "peer": message.peer, "remote": isRemote });
	}
});
