/** The referee, in its own worker: the page's child in the hub tree, and the hub every client links to. */
import type { Referee } from "../net/index.ts";
import type { AttachMessage, InitMessage, RefereeControl, RefereeInspection } from "./bootstrap.ts";
import { createHub, portTransport, serve } from "@brianjenkins94/hub";
import { createReferee, lobbyPermissions } from "../net/index.ts";
import { encodeUnit, nextInt, spawnUnit, tiles, visibleUnits } from "../sim/index.ts";
import { MATCH, REFEREE_CONTROL, REFEREE_INSPECT, TICK_MS } from "./bootstrap.ts";
import { observe } from "./telemetry.ts";

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

		replaced?.();
		links.set(message.peer, hub.link(portTransport(message.port), { "peer": message.peer, "permissions": lobbyPermissions(MATCH, message.peer, debugHost) }));

		if (replaced !== undefined) {
			log.info("client relinked", { "peer": message.peer });
		}
		log.info("client linked", { "peer": message.peer });
	}
});
