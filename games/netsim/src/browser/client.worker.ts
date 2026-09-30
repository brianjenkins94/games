/**
 * One client, in its instance's worker: links to its instance page (for drawing and input) and, over the channel the
 * page brokered, to the referee. Its hub id is the id the page gave it — the id the referee's hub knows it by.
 *
 * A remote client (its referee in the host's tab) belongs to two trees — its own tab's and the host's — and joins
 * neither to the other: both links are non-transit, and it confines the host's link to the game (hostPermissions).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Client } from "../net/index.ts";
import type { ClientInspection, InstanceInput, InstanceView, PortMessage } from "./bootstrap.ts";
import { createHub, portTransport, serve } from "@brianjenkins94/hub";
import { createClient, hostPermissions, subjects } from "../net/index.ts";
import { approxDistance, createRng, encodeUnit, nextInt, tiles, validateCommand } from "../sim/index.ts";
import { channelTransport, instanceSubjects, MATCH, TICK_MS } from "./bootstrap.ts";
import { observe } from "./telemetry.ts";

function start({ id, port, channel, bots = true, token, remote = false, debugHost }: PortMessage): void {
	const hub: Hub = createHub({ "id": id });
	const names = subjects(MATCH);
	const local = instanceSubjects(id);
	const client: Client = createClient({ "hub": hub, "match": MATCH });
	const rng = createRng([...id].reduce((sum, char) => sum + char.charCodeAt(0), 7));
	let selected: number | undefined;

	const { log } = observe(hub);
	const reported = { "gaps": 0, "desyncs": 0, "snaps": 0 };

	hub.link(portTransport(globalThis), remote ? { "transit": false } : {});
	hub.link(channel === undefined ? portTransport(port!) : channelTransport(channel), remote ? { "transit": false, "permissions": hostPermissions(MATCH, id, { "debugHost": debugHost }) } : {});

	// Debugging (reachable only from the debug host — the referee's hub permits nothing else to call these).
	serve(hub, names.debug(id, "inspect"), (): ClientInspection => ({
		"peer": id,
		"team": client.team(),
		"viewTick": client.viewTick(),
		"viewHash": client.viewHash(),
		"inSync": client.inSync(),
		"stats": { ...client.stats },
		"units": [...client.view().values()].map(encodeUnit),
		"predicted": [...client.predicted()?.units.values() ?? []].map(encodeUnit)
	}));
	serve(hub, names.debug(id, "command"), (args) => {
		const { command } = args as { "command": unknown };
		const predicted = client.predicted();
		const team = client.team();

		if (predicted === undefined || team === undefined) {
			throw new Error(`${id} isn't seated yet`);
		}

		// What the referee will say, checked against this client's prediction (the referee has the final word).
		const validation = validateCommand(predicted, team, command);

		client.command(command);
		log.info("debug command", { "command": command, "ok": validation.ok });

		return { ...validation, "viewTick": client.viewTick() };
	});

	const own = () => [...client.view().values()].filter((unit) => unit.team === client.team());

	hub.subscribe(local.input, (data) => {
		const input = data as InstanceInput;

		if (input.action === "select") {
			let best: number | undefined;
			let bestDistance = Infinity;

			for (const unit of own()) {
				const distance = approxDistance(unit.x - input.x, unit.y - input.y);

				if (distance < bestDistance) {
					best = unit.id;
					bestDistance = distance;
				}
			}

			selected = best;
		} else if (selected !== undefined) {
			client.command({ "type": "move", "units": [selected], "x": Math.trunc(input.x), "y": Math.trunc(input.y) });
		}
	});

	void client.join({ "timeoutMs": 10_000, ...token === undefined ? {} : { "token": token } }).then((seat) => {
		log.info(token === seat.token ? "rejoined" : "joined", { "team": seat.team });
		setInterval(() => {
			const config = client.config();

			if (bots && nextInt(rng, 0, 100) < 10) {
				const units = own().filter((unit) => unit.id !== selected);

				if (units.length > 0) {
					const unit = units[nextInt(rng, 0, units.length)];

					client.command({ "type": "move", "units": [unit.id], "x": nextInt(rng, 0, tiles(config.width)), "y": nextInt(rng, 0, tiles(config.height)) });
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
				"config": config,
				"units": [...client.view().values()].map(encodeUnit),
				"predicted": [...client.predicted().units.values()].map(encodeUnit),
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
	if (event.data?.type === "netsim-port") {
		start(event.data);
	}
});
