/**
 * One client, in its instance's worker: links to its instance page (for drawing and input) and, over the channel the
 * page brokered, to the referee. Its hub id is the id the page gave it — the id the referee's hub knows it by.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Client } from "../net/index.ts";
import type { InstanceInput, InstanceView, PortMessage } from "./bootstrap.ts";
import { createHub, portTransport } from "@brianjenkins94/hub";
import { createClient, subjects } from "../net/index.ts";
import { approxDistance, createRng, encodeUnit, nextInt, tiles } from "../sim/index.ts";
import { instanceSubjects, MATCH, TICK_MS } from "./bootstrap.ts";

function start(id: string, port: MessagePort, bots: boolean): void {
	const hub: Hub = createHub({ "id": id });
	const names = subjects(MATCH);
	const local = instanceSubjects(id);
	const client: Client = createClient({ "hub": hub, "match": MATCH });
	const rng = createRng([...id].reduce((sum, char) => sum + char.charCodeAt(0), 7));
	let selected: number | undefined;

	hub.link(portTransport(globalThis));
	hub.link(portTransport(port));

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

	void client.join({ "timeoutMs": 10_000 }).then(() => {
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
				"stats": { ...client.stats }
			} satisfies InstanceView);
		}, TICK_MS);
	});
}

globalThis.addEventListener("message", (event: MessageEvent<PortMessage | undefined>) => {
	if (event.data?.type === "netsim-port") {
		start(event.data.id, event.data.port, event.data.bots !== false);
	}
});
