/**
 * One client, in its instance's worker — the host's own player as much as another tab's (W3, see MIGRATION.md: the
 * host's player as a client worker like any other). It links to its instance page (for drawing and input) and, over
 * the data channel its page handed it (rtc.ts), to the referee. Nobody tells it who it is: the referee's hub assigns its
 * id (LinkOptions.peer) and says so in its hello (hub's knownAs).
 *
 * It belongs to two trees — its own tab's and the referee's — and joins neither to the other: both links are
 * non-transit, and it confines the referee's link to the game (hostPermissions). Fog is its own: it sends its page only
 * its team's view and what its team has explored.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Client } from "../net/index.ts";
import type { Command } from "../sim/command.ts";
import type { ClientInspection, InstanceInput, InstanceView, PortMessage, UnitInfo } from "./bootstrap.ts";
import { createHub, dataChannelTransport, portTransport, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { createClient, hostPermissions, subjects } from "../net/index.ts";
import { CmdType } from "../sim/command.ts";
import { tileCenterFP } from "../sim/components.ts";
import { snapshotUnit } from "../sim/snapshot.ts";
import { validateCommand } from "../sim/validate.ts";
import { exploredRuns } from "../sim/vision.ts";
import { unitEids } from "../sim/world.ts";
import { describe, instanceSubjects, MATCH, TICK_MS } from "./bootstrap.ts";
import { loadMap } from "./maps.ts";

async function start({ channel, bots = true, token }: PortMessage): Promise<void> {
	// Its own name is a placeholder that nobody sees (both its links name it): who it is comes from the referee.
	const hub: Hub = createHub({ "id": "client" });

	// The referee is its uplink: the hub that decides who it is (only an uplink's hello can name a hub). Its link is
	// confined — to nothing until the client knows its id, then to the game (hostPermissions).
	const toReferee = hub.link(dataChannelTransport(channel), { "uplink": true, "transit": false, "permissions": { "publish": [], "subscribe": [] } });

	hub.link(portTransport(globalThis), { "transit": false });
	await toReferee.ready;

	const id = hub.knownAs()[0];

	if (id === undefined) {
		throw new Error("the referee didn't say who this client is");
	}

	hub.permit("referee", hostPermissions(MATCH, id));

	const names = subjects(MATCH);
	const local = instanceSubjects(id);
	const client: Client = createClient({ "hub": hub, "match": MATCH, "loadMap": loadMap });
	let seed = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 7);
	const random = (bound: number): number => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;

		return (seed >>> 8) % bound;
	};
	let selected: number[] = [];
	const { log } = observe(hub, { "network": true });
	const reported = { "gaps": 0, "desyncs": 0, "snaps": 0 };
	const own = (): UnitInfo[] => [...client.view().values()].map(describe).filter((unit) => unit.team === client.team());
	const predicted = (): UnitInfo[] => {
		const world = client.predicted();

		return world === undefined ? [] : unitEids(world).map((eid) => describe(snapshotUnit(world, eid))).filter((unit) => unit.team === client.team());
	};

	// Debugging, from its own tab (its page reaches it through its instance; the referee's link carries no calls to these).
	serve(hub, local.debug("inspect"), (): ClientInspection => ({
		"peer": id,
		"team": client.team(),
		"viewTick": client.viewTick(),
		"viewHash": client.viewHash(),
		"inSync": client.inSync(),
		"stats": { ...client.stats },
		"view": [...client.view().values()].sort((left, right) => left.uid - right.uid),
		"predicted": predicted()
	}));
	serve(hub, local.debug("command"), (args) => {
		const { command } = args as { "command": unknown };
		const world = client.predicted();
		const team = client.team();

		if (world === undefined || team === undefined) {
			throw new Error(`${id} isn't seated yet`);
		}

		// What the referee will say, checked against this client's prediction (the referee has the final word).
		const validation = validateCommand(world, team, command);

		if (validation.ok) {
			client.command(validation.command);
		}

		log.info("debug command", { "command": command, "ok": validation.ok });

		return { ...validation, "viewTick": client.viewTick() };
	});

	hub.subscribe(local.input, (data) => {
		const input = data as InstanceInput;
		const world = client.predicted();
		const team = client.team();

		if (input.action === "select") {
			selected = Array.isArray(input.uids) ? input.uids.filter((uid) => Number.isSafeInteger(uid)) : [];
		} else if (world !== undefined && team !== undefined) {
			// The referee checks it again; checked here, a bad one isn't predicted or sent at all.
			const validation = validateCommand(world, team, input.command);

			if (validation.ok) {
				client.command(validation.command);
			} else {
				log.info("command refused", { "reason": "reason" in validation ? validation.reason : undefined });
			}
		}
	});

	void client.join({ "timeoutMs": 10_000, ...token === undefined ? {} : { "token": token } }).then(async (seat) => {
		const map = await loadMap(seat.map);

		log.info(token === seat.token ? "rejoined" : "joined", { "team": seat.team, "map": seat.map });
		setInterval(() => {
			if (bots && random(100) < 10) {
				const units = own().filter((unit) => unit.building === undefined && !selected.includes(unit.uid));

				if (units.length > 0) {
					const command: Command = { "type": CmdType.MOVE, "unitIds": [units[random(units.length)].uid], "txFP": tileCenterFP(random(map.mapW)), "tyFP": tileCenterFP(random(map.mapH)) };

					client.command(command);
				}
			}

			client.tick();

			// Faults the protocol recovered from: worth a line each time they happen.
			for (const key of ["gaps", "desyncs", "snaps"] as const) {
				if (client.stats[key] > reported[key]) {
					log.warn(key, { "total": client.stats[key], "viewTick": client.viewTick() });
					reported[key] = client.stats[key];
				}
			}

			hub.publish(names.diag(id), { "peer": id, "team": client.team(), "viewTick": client.viewTick(), "viewHash": client.viewHash(), "stats": { ...client.stats } });
			hub.publish(local.view, {
				"id": id,
				"team": client.team(),
				"viewTick": client.viewTick(),
				"inSync": client.inSync(),
				"map": seat.map,
				"units": [...client.view().values()].map(describe),
				"predicted": predicted(),
				"explored": exploredRuns(client.predicted(), seat.team),
				"selected": selected,
				"stats": { ...client.stats },
				"token": seat.token
			} satisfies InstanceView);
		}, TICK_MS);
	}, (error: unknown) => {
		log.error("join failed", { "error": error instanceof Error ? error.message : String(error) });
	});
}

globalThis.addEventListener("message", (event: MessageEvent<PortMessage | undefined>) => {
	if (event.data?.type === "war2-port") {
		void start(event.data);
	}
});
