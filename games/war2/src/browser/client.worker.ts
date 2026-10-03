/**
 * One client, in its instance's worker — the host's own player as much as another tab's (W3, see MIGRATION.md: the
 * host's player as a client worker like any other). It links to its instance page (for drawing and input) and, over
 * the data channel its page handed it (hub's answerLink), to the referee. Nobody tells it who it is: the referee's hub assigns its
 * id (LinkOptions.peer) and says so in its hello (hub's knownAs).
 *
 * It belongs to two trees — its own tab's and the referee's — and joins neither to the other: both links are
 * non-transit, and it confines the referee's link to the game (hostPermissions). Fog is its own: it sends its page only
 * its team's view and what its team has explored.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Client } from "../net/index.ts";
import type { ClientInspection, InstanceInput, PortMessage } from "./contract.ts";
import type { InstanceView, UnitInfo } from "../net/view.ts";
import { createHub, portTransport, rpcCallSubject, serve } from "@brianjenkins94/hub";
import { meteredDataChannel, observe, reportMetrics } from "@brianjenkins94/observability";
import { createClient, hostPermissions, subjects } from "../net/index.ts";
import { createBot } from "../sim/bot.ts";
import { snapshotUnit } from "../sim/snapshot.ts";
import { validateCommand } from "../sim/validate.ts";
import { exploredRuns } from "../sim/vision.ts";
import { unitEids } from "../sim/world.ts";
import { instanceSubjects, MATCH } from "./contract.ts";
import { describe } from "../net/view.ts";
import { TICK_MS } from "../sim/components.ts";
import { loadMap } from "../maps.ts";

async function start({ channel, bots = true, token }: PortMessage): Promise<void> {
	// Its own name is a placeholder that nobody sees (both its links name it): who it is comes from the referee.
	const hub: Hub = createHub({ "id": "client" });
	// Observed before it opens anything: the probes see only what's created after them (GAPS).
	const { log } = observe(hub, { "network": true });
	// What its data channel carries (observability's), weighed from the start: the link sends through the meter.
	const wire = meteredDataChannel(channel);

	// The referee is its uplink: the hub that decides who it is (only an uplink's hello can name a hub). Its link is
	// confined — to nothing until the client knows its id, then to the game (hostPermissions).
	const toReferee = hub.link(wire.transport, { "uplink": true, "transit": false, "permissions": { "publish": [], "subscribe": [] } });

	// Its page sends it only clicks, debug calls from its own tab, and observability's traffic — and gets back only its
	// view, the debug calls' replies, and observability's. In the host's tab the referee is in the page's tree too (the
	// tab's one loop: this worker is a leaf on both sides), so without the first its team's state came twice — over the
	// data channel and down the tab — and without the second its diag reached the host page twice: the referee's way
	// (every client's, remote ones too) and this one.
	hub.link(portTransport(globalThis), { "transit": false, "permissions": {
		"publish": [`war2.${MATCH}.input.*`, rpcCallSubject(`war2.${MATCH}.debug.*.*`), "$sys.>"],
		"subscribe": [`war2.${MATCH}.view.*`, "$rpc.reply.>", "$sys.>"]
	} });
	await toReferee.ready;

	const id = toReferee.knownAs;

	if (id === undefined) {
		throw new Error("the referee didn't say who this client is");
	}

	toReferee.permit(hostPermissions(MATCH, id));

	const names = subjects(MATCH);
	const local = instanceSubjects(id);
	const client: Client = createClient({ "hub": hub, "match": MATCH, "loadMap": loadMap });
	// Its gauges (observability's): what it sees, and its wire. (How far behind the referee its view is, the host knows: `lag`.)
	// Unnamed: its instance's link names it, as it does its logs.
	const metrics = reportMetrics(hub);

	metrics.gauge("units", () => client.view().size);
	metrics.gauge("wire", wire.gauge);
	let selected: number[] = [];
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

	// The referee answers once its map is loaded, and that can take a while — a capability prompt in the editor waits
	// on the user — so no responder yet means try again, not give up. Any other failure (a refusal) is final.
	const joinWhenServed = async (): Promise<Awaited<ReturnType<Client["join"]>>> => {
		for (let waited = false; ; waited = true) {
			try {
				return await client.join({ "timeoutMs": 10_000, ...token === undefined ? {} : { "token": token } });
			} catch (error) {
				if (!(error instanceof Error && error.message.includes("no responder"))) {
					throw error;
				}

				if (!waited) {
					log.info("waiting for the referee");
				}
			}
		}
	};

	void joinWhenServed().then(async (seat) => {
		const map = await loadMap(seat.map);
		const bot = bots ? createBot(id, map.mapW, map.mapH) : undefined;

		log.info(token === seat.token ? "rejoined" : "joined", { "team": seat.team, "map": seat.map });
		setInterval(() => {
			const command = bot?.(own(), selected);

			if (command !== undefined) {
				client.command(command);
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
