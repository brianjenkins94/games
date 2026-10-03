/**
 * One client, in its instance's worker: links to its instance page (for drawing and input) and, over the data
 * channel its page handed it (rtc.ts), to the referee. Nobody tells it who it is: the referee's hub assigns its id
 * (LinkOptions.peer) and says so in its hello (hub's knownAs) — the id it's stamped with, permitted as, and names its
 * subjects by. Its logs and reports go out under its hub's own id, to its own tab, and the edge names them: its
 * instance.
 *
 * It belongs to two trees — its own tab's and the referee's — and joins neither to the other: both links are
 * non-transit, and it confines the referee's link to the game (hostPermissions).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Client } from "../net/index.ts";
import type { ClientInspection, InstanceInput, InstanceView, PortMessage } from "./bootstrap.ts";
import { createHub, dataChannelTransport, portTransport, rpcCallSubject, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import { createClient, hostPermissions, subjects } from "../net/index.ts";
import { approxDistance, createRng, encodeUnit, nextInt, tiles, validateCommand } from "../sim/index.ts";
import { instanceSubjects, MATCH, TICK_MS } from "./bootstrap.ts";

async function start({ channel, bots = true, token }: PortMessage): Promise<void> {
	// Its own name is a placeholder that nobody sees (both its links name it): who it is comes from the referee.
	const hub: Hub = createHub({ "id": "client" });
	// Observed before it opens anything: the probes see only what's created after them (GAPS).
	const { log } = observe(hub, { "network": true });

	// The referee is its uplink: the hub that decides who it is (only an uplink's hello can name a hub). Its link is
	// confined — to nothing until the client knows its id, then to the game (hostPermissions). The hello that carries the
	// id is a control frame, which permissions don't stop.
	const toReferee = hub.link(dataChannelTransport(channel), { "uplink": true, "transit": false, "permissions": { "publish": [], "subscribe": [] } });

	// Its page sends it only clicks, debug calls from its own tab, and observability's traffic — and gets back only its
	// view, the debug calls' replies, and observability's. In the host's tab the referee is in the page's tree too (the
	// tab's one loop: this worker is a leaf on both sides), so without the first its team's state came twice — over the
	// data channel and down the tab — and without the second its diag reached the host page twice: the referee's way
	// (every client's, remote ones too) and this one.
	hub.link(portTransport(globalThis), { "transit": false, "permissions": {
		"publish": [`netsim.${MATCH}.input.*`, rpcCallSubject(`netsim.${MATCH}.debug.*.*`), "$sys.>"],
		"subscribe": [`netsim.${MATCH}.view.*`, "$rpc.reply.>", "$sys.>"]
	} });
	await toReferee.ready;

	const id = toReferee.knownAs;

	if (id === undefined) {
		throw new Error("the referee didn't say who this client is");
	}

	toReferee.permit(hostPermissions(MATCH, id));

	const names = subjects(MATCH);
	const local = instanceSubjects(id);
	const client: Client = createClient({ "hub": hub, "match": MATCH });
	const rng = createRng([...id].reduce((sum, char) => sum + char.charCodeAt(0), 7));
	let selected: number | undefined;
	const reported = { "gaps": 0, "desyncs": 0, "snaps": 0 };

	// Debugging, from its own tab (its page reaches it through its instance; the referee's link carries no calls to these).
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
		void start(event.data);
	}
});
