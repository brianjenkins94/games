/**
 * The host page: starts the referee worker and one instance iframe per client, brokers each client's channel to the
 * referee, and shows every client's status checked against the referee (its view hash at that tick must match the
 * referee's hash of what that team can see).
 */
import type { ClientDiag, RefereeTick } from "../net/index.ts";
import type { AttachMessage, InitMessage, PortMessage } from "./bootstrap.ts";
import { createHub, portTransport } from "@brianjenkins94/hub";
import { subjects } from "../net/index.ts";
import { tiles } from "../sim/index.ts";
import { MATCH, readSettings } from "./bootstrap.ts";
import { observeRoot, ownWorker } from "./telemetry.ts";
import { netsimTools } from "./tools.ts";

const settings = readSettings(location.search);
const names = subjects(MATCH);
const hub = createHub({ "id": "page" });
const referee = new Worker(new URL("referee.worker.ts", import.meta.url), { "type": "module", "name": "referee" });
const grid = document.querySelector<HTMLElement>("#instances")!;
const status = document.querySelector<HTMLTableSectionElement>("#status tbody")!;
const summary = document.querySelector<HTMLElement>("#summary")!;
/** The referee's view hashes for recent ticks, to check a client's report at whatever tick it's on. */
const history = new Map<number, RefereeTick>();
const diags = new Map<string, ClientDiag>();
let last: RefereeTick | undefined;

const tools = netsimTools(hub, () => currentStatus());
const telemetry = observeRoot(hub, { "tools": tools });

ownWorker(referee, telemetry.log, "referee");
telemetry.log.info("match starting", { ...settings, "debug": telemetry.tab !== undefined });
hub.link(portTransport(referee));
referee.postMessage({
	"type": "netsim-init",
	"config": { "width": 24, "height": 24, "teams": settings.teams, "seed": settings.seed, "speed": 125, "sight": tiles(5) },
	"perTeam": settings.perTeam,
	// Only when debugging is on does the referee let the page reach into clients.
	...telemetry.tab === undefined ? {} : { "debugHost": hub.id }
} satisfies InitMessage);

for (let index = 0; index < settings.clients; index += 1) {
	const id = `client-${index}`;
	const frame = document.createElement("iframe");

	frame.src = `instance.html?id=${id}&bots=${settings.bots ? 1 : 0}`;
	frame.title = id;
	frame.addEventListener("load", () => {
		const channel = new MessageChannel();

		referee.postMessage({ "type": "netsim-attach", "peer": id, "port": channel.port1 } satisfies AttachMessage, [channel.port1]);
		frame.contentWindow!.postMessage({ "type": "netsim-port", "id": id, "port": channel.port2 } satisfies PortMessage, location.origin, [channel.port2]);
	}, { "once": true });
	grid.append(frame);
}

hub.subscribe(names.refereeTick, (data) => {
	last = data as RefereeTick;
	history.set(last.tick, last);
	history.delete(last.tick - 100);
});
hub.subscribe(names.diag("*"), (data) => {
	const diag = data as ClientDiag;

	diags.set(diag.peer, diag);
});

/** A client is in sync when its view hash matches the referee's for its team at the tick it's on. */
function checkClient(diag: ClientDiag): "in sync" | "behind" | "OUT OF SYNC" | "joining" {
	if (diag.team === undefined || diag.viewTick < 0) {
		return "joining";
	}

	const expected = history.get(diag.viewTick)?.viewHashes[diag.team];

	if (expected === undefined) {
		return "behind";
	}

	return expected === diag.viewHash ? "in sync" : "OUT OF SYNC";
}

function render(): void {
	const rows = [...diags.values()].sort((left, right) => left.peer.localeCompare(right.peer)).map((diag) => {
		const row = document.createElement("tr");
		const state = checkClient(diag);
		const cells = [diag.peer, String(diag.team ?? "–"), String(diag.viewTick), state, String(last === undefined ? "–" : last.tick - diag.viewTick), ...["keyframes", "gaps", "desyncs", "snaps", "batchesSent"].map((key) => String(diag.stats[key] ?? 0))];

		row.dataset["state"] = state;

		for (const text of cells) {
			const cell = document.createElement("td");

			cell.textContent = text;
			row.append(cell);
		}

		return row;
	});

	status.replaceChildren(...rows);
	summary.textContent = last === undefined ? "starting…" : `tick ${last.tick} · ${last.seats.length} seated · ${last.stats["commandsApplied"]} commands applied · ${last.stats["commandsRejected"]} rejected`;
}

setInterval(render, 250);

/** The latest status, as data. */
function currentStatus() {
	return {
		"tick": last?.tick,
		"clients": [...diags.values()].sort((left, right) => left.peer.localeCompare(right.peer)).map((diag) => ({ "peer": diag.peer, "team": diag.team, "viewTick": diag.viewTick, "state": checkClient(diag), "stats": diag.stats }))
	};
}

/** For scripts and debugging. */
(globalThis as unknown as { "__netsim": unknown }).__netsim = {
	"hub": hub,
	"logs": (source?: string) => telemetry.records.filter((record) => source === undefined || record.context?.["source"] === source),
	"architecture": () => telemetry.store.snapshot(),
	"tab": telemetry.tab,
	"status": currentStatus,
	/** The MCP tools this page serves, callable directly: `await __netsim.tool("netsim_status")`. */
	"tool": async (name: string, args: Record<string, unknown> = {}) => await tools.find((tool) => tool.name === name)?.handler(args)
};
