/** The referee, in its own worker: the page's child in the hub tree, and the hub every client links to. */
import type { AttachMessage, InitMessage } from "./bootstrap.ts";
import { createHub, portTransport } from "@brianjenkins94/hub";
import { createReferee, lobbyPermissions } from "../net/index.ts";
import { nextInt, spawnUnit, tiles } from "../sim/index.ts";
import { MATCH, TICK_MS } from "./bootstrap.ts";
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

globalThis.addEventListener("message", (event: MessageEvent<InitMessage | AttachMessage | undefined>) => {
	const message = event.data;

	if (message?.type === "netsim-init") {
		const referee = createReferee({
			"hub": hub,
			"match": MATCH,
			"config": message.config,
			"setup": (world) => {
				for (let team = 0; team < world.config.teams; team += 1) {
					for (let index = 0; index < message.perTeam; index += 1) {
						spawnUnit(world, team, nextInt(world.rng, 0, tiles(world.config.width)), nextInt(world.rng, 0, tiles(world.config.height)));
					}
				}
			}
		});

		let seated = "";

		log.info("referee started", { "teams": message.config.teams, "units": referee.world.units.size });
		setInterval(() => {
			referee.tick();

			const seats = referee.seats().map((seat) => `${seat.peer}=${seat.team}`).join(",");

			if (seats !== seated) {
				seated = seats;
				log.info("seats", { "seats": seats });
			}
		}, TICK_MS);
	} else if (message?.type === "netsim-attach") {
		hub.link(portTransport(message.port), { "peer": message.peer, "permissions": lobbyPermissions(MATCH, message.peer) });
		log.info("client linked", { "peer": message.peer });
	}
});
