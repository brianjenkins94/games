/** The referee, in its own worker: the host page's child in the hub tree, and the hub every client links to. Its host
 *  controls — inspect, pause / step, speed — are served here, on the host tab's own tree: no client link carries them
 *  (W3, see MIGRATION.md: speed as a host RPC). */
import type { Referee } from "../net/index.ts";
import type { Recorder } from "../diag/recorder.ts";
import type { AttachMessage, DiagRequest, InitMessage, RefereeControl, RefereeInspection } from "./bootstrap.ts";
import { createHub, dataChannelTransport, portTransport, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { createReferee, lobbyPermissions, teamView } from "../net/index.ts";
import { tileCenterFP } from "../sim/components.ts";
import { rngRange } from "../sim/rng.ts";
import { snapshotUnit } from "../sim/snapshot.ts";
import { unitTypeId } from "../sim/unitTypes.ts";
import { canPlaceBuilding, spawnBuilding, spawnUnit, unitEids } from "../sim/world.ts";
import { createRecorder } from "../diag/recorder.ts";
import { describe, MATCH, REFEREE_CONTROL, REFEREE_DIAG, REFEREE_INSPECT, TICK_MS } from "./bootstrap.ts";
import { loadGameMap } from "./maps.ts";

const hub = createHub({ "id": "referee" });
const { log } = observe(hub, { "network": true });

hub.link(portTransport(globalThis));

// What link permissions refuse is worth seeing: a client asking for another team's view, or sending what it may not.
// And a client's link going: its data channel closed (its tab went), or it stopped answering.
hub.tap((event) => {
	if (event.type === "deny" && !event.envelope.subject.startsWith("$sys.")) {
		log.warn("denied", { "peer": event.link.peerId, "direction": event.direction, "subject": event.envelope.subject });
	} else if (event.type === "fault" && (event.kind === "closed" || event.kind === "stale")) {
		log.info("client gone", { "peer": event.link?.peerId, "why": event.detail });
	}
});

/** Each client's current link, by peer id: a reloaded instance attaches again, replacing its dead one. */
const links = new Map<string, () => void>();
let paused = false;
let speed = 1;
let current: Referee | undefined;
let recorder: Recorder | undefined;
let match: InitMessage["settings"] | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let seated = "";

function tick(): void {
	// Paused, the world stands still — but a client that (re)joins, or asks to resync, still gets its view.
	if (paused) {
		current.sync();

		return;
	}

	current.tick();

	const seats = current.seats().map((seat) => `${seat.peer}=${seat.team}`).join(",");

	if (seats !== seated) {
		seated = seats;
		log.info("seats", { "seats": seats });
	}
}

/** (Re)start the tick loop at the current speed. */
function run(): void {
	clearInterval(timer);
	timer = setInterval(tick, TICK_MS / speed);
}

serve(hub, REFEREE_INSPECT, (): RefereeInspection | undefined => {
	if (current === undefined) {
		return undefined;
	}

	const { world } = current;
	const seats = current.seats();

	return {
		"tick": world.tick,
		"paused": paused,
		"speed": speed,
		"seats": seats,
		"stats": { ...current.stats },
		"units": unitEids(world).map((eid) => describe(snapshotUnit(world, eid))).sort((left, right) => left.uid - right.uid),
		"views": Object.fromEntries(seats.map((seat) => [seat.team, teamView(world, seat.team)]))
	};
});
serve(hub, REFEREE_CONTROL, (args) => {
	const { action, ticks = 1, speed: requested } = args as RefereeControl;

	if (current === undefined) {
		throw new Error("the match hasn't started");
	}

	if (action === "step") {
		paused = true;

		for (let index = 0; index < Math.max(1, Math.min(ticks, 1000)); index += 1) {
			current.tick();
		}
	} else if (action === "speed") {
		if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0.25 || requested > 8) {
			throw new Error("speed: a multiplier from 0.25 to 8");
		}

		speed = requested;
		run();
	} else {
		paused = action === "pause";
	}

	log.info("control", { "action": action, "tick": current.world.tick, "speed": speed });

	return { "tick": current.world.tick, "paused": paused, "speed": speed };
});

/** Start the match: load its map (built in, or fetched from the assets mirror), then the referee and its tick loop. */
async function start(settings: InitMessage["settings"]): Promise<void> {
	const gameMap = await loadGameMap(settings.map);
	const map = gameMap.info;

	match = settings;
	recorder = createRecorder();

	current = createReferee({
		"hub": hub,
		"match": MATCH,
		"seed": settings.seed,
		"map": settings.map,
		"mapInfo": map,
		"teams": settings.teams,
		"observe": (world, applied) => {
			const before = recorder.incidents().length;

			recorder.observe(world, applied);

			for (const incident of recorder.incidents().slice(before)) {
				log.warn("incident", { "id": incident.id, "label": incident.label, "tick": incident.flagTick });
			}
		},
		"setup": (world) => {
			// Each team at its start (the map's, else a band of its own), as a WC2 match opens: a town hall, finished,
			// two workers beside it, and soldiers for the rest. Humans and orcs in turn.
			for (let team = 0; team < settings.teams; team += 1) {
				const orc = team % 2 === 1;
				const [sx, sy] = gameMap.starts[team] ?? [Math.floor(((team + 0.5) / settings.teams) * map.mapW), Math.floor(map.mapH / 2)];
				const hallType = unitTypeId(orc ? "unit-great-hall" : "unit-town-hall");
				const [hx, hy] = [Math.min(map.mapW - 4, Math.max(0, sx - 2)), Math.min(map.mapH - 4, Math.max(0, sy - 2))];

				if (canPlaceBuilding(world, hx, hy, hallType)) {
					const hall = spawnBuilding(world, hx, hy, team, hallType);

					if (hall !== -1) {
						world.components.Building.buildLeft[hall] = 0;
					}
				}

				for (let placed = 0, tries = 0; placed < settings.perTeam && tries < 1000; tries += 1) {
					const type = unitTypeId(placed < 2 ? (orc ? "unit-peon" : "unit-peasant") : (orc ? "unit-grunt" : "unit-footman"));
					const tx = Math.min(map.mapW - 1, Math.max(0, sx + rngRange(world, -5, 6)));
					const ty = Math.min(map.mapH - 1, Math.max(0, sy + rngRange(world, -5, 6)));

					if (world.terrain.pass[ty * map.mapW + tx] === 0 && world.occupancy[ty * map.mapW + tx] === 0 && spawnUnit(world, tileCenterFP(tx), tileCenterFP(ty), team, undefined, type) !== -1) {
						placed += 1;
					}
				}
			}
		}
	});
	log.info("referee started", { "teams": settings.teams, "map": settings.map, "units": current.world.eidOf.size });
	run();
}

// The flight recorder (pull, not push): what the host's tools ask of the match's recent past.
serve(hub, REFEREE_DIAG, (args) => {
	const request = args as DiagRequest;

	if (current === undefined || recorder === undefined) {
		throw new Error("the match hasn't started");
	}

	const { world } = current;

	switch (request.op) {
		case "pathologies":
			return recorder.pathologies().map(({ uid, pathology }) => {
				const eid = world.eidOf.get(uid);

				return { "pathology": pathology, ...eid === undefined ? { "uid": uid } : describe(snapshotUnit(world, eid)) };
			});
		case "incidents":
			return recorder.incidents();
		case "commands":
			return recorder.commands();
		case "track":
			return recorder.track(request.uid);
		case "flag": {
			const incident = recorder.flag(world, request.label ?? "flagged by hand");

			log.info("incident flagged", { "id": incident.id, "label": incident.label, "tick": incident.flagTick });

			return recorder.incidents().find((summary) => summary.id === incident.id);
		}

		case "incident": {
			const incident = recorder.incident(request.id);

			return incident === undefined ? undefined : { ...incident, "snapshot": undefined, "units": incident.snapshot.units.map(describe) };
		}

		case "fixture":
			return recorder.fixture(request.id, { "map": match.map, "seed": match.seed, "teams": match.teams });
		case "replay": {
			const incident = recorder.incident(request.id);

			if (incident === undefined) {
				throw new Error(`no incident ${request.id}`);
			}

			// Rewound to its lead-up, paused: step through it (war2_control), its commands applying again at their ticks.
			paused = true;
			current.restore(incident.snapshot, incident.commands);
			recorder.reset();
			log.info("incident replayed", { "id": incident.id, "tick": world.tick });

			return { "tick": world.tick, "paused": true, "flagTick": incident.flagTick };
		}

		default:
			throw new Error("unknown diagnostics request");
	}
});

globalThis.addEventListener("message", (event: MessageEvent<InitMessage | AttachMessage | undefined>) => {
	const message = event.data;

	if (message?.type === "war2-init") {
		void start(message.settings);
	} else if (message?.type === "war2-attach") {
		const replaced = links.get(message.peer);

		replaced?.();

		// Every client, ours or another tab's, over its own data channel (closed with its link). The link carries only the
		// game — the client's own tab observes and debugs it — heartbeat-checked (a killed tab's channel can take a while to
		// close) and bounded: a data channel's messages have a size limit, and a slow peer mustn't back up the referee.
		const { channel } = message;
		const unlink = hub.link(dataChannelTransport(channel), { "peer": message.peer, "permissions": lobbyPermissions(MATCH, message.peer), "heartbeatMs": 1000, "maxPayload": 64 * 1024, "maxBacklog": 256 * 1024 });

		links.set(message.peer, () => {
			unlink();
			channel.close();
		});
		log.info(replaced === undefined ? "client linked" : "client relinked", { "peer": message.peer });
	}
});
