/**
 * Hosting a match, in a page: starts the referee worker, brokers each client's channel to it — an instance iframe of
 * this page's (`addInstance`), or a player in another tab (`attachRemote`) — and shows every client's status checked
 * against the referee (its view hash at that tick must match the referee's hash of what that team can see).
 */
import type { ClientDiag, RefereeTick } from "../net/index.ts";
import type { AttachMessage, InitMessage, PortMessage, Settings } from "./bootstrap.ts";
import { createHub, portTransport } from "@brianjenkins94/hub";
import { subjects } from "../net/index.ts";
import { tiles } from "../sim/index.ts";
import { MATCH } from "./bootstrap.ts";
import { observeApp, ownWorker } from "@brianjenkins94/observability";
import { netsimTools } from "./tools.ts";

/** A client reports every tick, paused or not (see client.worker.ts); this long without one, it's stalled. */
const STALLED_MS = 1000;

export interface HostOptions {
	"settings": Settings;
	/** This page's match: an instance reloaded within it rejoins its seat; a reloaded page starts a new one. */
	"matchId": string;
	/** Where instance iframes go. */
	"grid": HTMLElement;
	"status": HTMLTableSectionElement;
	"summary": HTMLElement;
}

/** An instance iframe for client `id`, appended to `grid`; `onLoad` runs on every load of it (a reload included). */
export function createInstanceFrame(grid: HTMLElement, { id, matchId, bots }: { "id": string; "matchId": string; "bots": boolean }, onLoad: (frame: HTMLIFrameElement) => void): HTMLIFrameElement {
	const frame = document.createElement("iframe");

	frame.src = `instance.html?id=${id}&match=${matchId}&bots=${bots ? 1 : 0}`;
	frame.title = id;
	frame.addEventListener("load", () => { onLoad(frame); });
	grid.append(frame);

	return frame;
}

export function startHost({ settings, matchId, grid, status, summary }: HostOptions) {
	const names = subjects(MATCH);
	const hub = createHub({ "id": "page" });
	const referee = new Worker(new URL("referee.worker.ts", import.meta.url), { "type": "module", "name": "referee" });
	/** The referee's view hashes for recent ticks, to check a client's report at whatever tick it's on. */
	const history = new Map<number, RefereeTick>();
	/** Each client's latest report, and when it arrived. */
	const diags = new Map<string, ClientDiag & { "receivedAt": number }>();
	let last: RefereeTick | undefined;

	const tools = netsimTools(hub, () => currentStatus());
	const telemetry = observeApp(hub, { "tools": tools });

	ownWorker(referee, () => { telemetry.log.error("worker failed to load", { "worker": "referee" }); });
	telemetry.log.info("match starting", { ...settings, "match": matchId, "debug": telemetry.tab !== undefined });
	hub.link(portTransport(referee));
	referee.postMessage({
		"type": "netsim-init",
		"config": { "width": 24, "height": 24, "teams": settings.teams, "seed": settings.seed, "speed": 125, "sight": tiles(5) },
		"perTeam": settings.perTeam,
		// Only when debugging is on does the referee let the page reach into clients.
		...telemetry.tab === undefined ? {} : { "debugHost": hub.id }
	} satisfies InitMessage);

	hub.subscribe(names.refereeTick, (data) => {
		last = data as RefereeTick;
		history.set(last.tick, last);
		history.delete(last.tick - 100);
	});
	hub.subscribe(names.diag("*"), (data) => {
		const diag = data as ClientDiag;

		diags.set(diag.peer, { ...diag, "receivedAt": Date.now() });
	});

	/** A client is in sync when its view hash matches the referee's for its team at the tick it's on — and it's still
	 *  reporting: a client that stopped (its worker died, its instance hung) is stalled, whatever it last said. */
	function checkClient(diag: ClientDiag & { "receivedAt": number }): "in sync" | "behind" | "OUT OF SYNC" | "joining" | "stalled" {
		if (Date.now() - diag.receivedAt > STALLED_MS) {
			return "stalled";
		}

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

	return {
		"hub": hub,
		"telemetry": telemetry,
		/** Seat a client in an instance iframe of this page's: on every load of it, a fresh channel to the referee (its
		 *  worker, and the old channel's end, died with the old document). */
		"addInstance": (id: string): HTMLIFrameElement => createInstanceFrame(grid, { "id": id, "matchId": matchId, "bots": settings.bots }, (frame) => {
			const channel = new MessageChannel();

			referee.postMessage({ "type": "netsim-attach", "peer": id, "port": channel.port1 } satisfies AttachMessage, [channel.port1]);
			frame.contentWindow!.postMessage({ "type": "netsim-port", "port": channel.port2 } satisfies PortMessage, location.origin, [channel.port2]);
		}),
		/** A player in another tab, known as `peer`: the BroadcastChannel its client links over (the lobby named it). */
		"attachRemote": (peer: string, channel: string): void => {
			referee.postMessage({ "type": "netsim-attach", "peer": peer, "channel": channel } satisfies AttachMessage);
		}
	};
}
