/**
 * Players in separate tabs (play.html?match=<id>): the first tab at a match hosts it — the referee, and its own player
 * (`player-0`) — and every tab of this origin that opens the same match after it joins as another player (whatever
 * page or path it was loaded from), its client linked to the host's referee over a channel the lobby names
 * (lobby.ts). Each tab is its own hub tree, observed on its own (its own tab in debug-mcp); the host's also serves
 * netsim's tools over the whole match.
 */
import type { InstanceView, PortMessage } from "./bootstrap.ts";
import { createHub, windowTransport } from "@brianjenkins94/hub";
import { instanceSubjects, readSettings } from "./bootstrap.ts";
import { createInstanceFrame, startHost } from "./host.ts";
import { joinLobby } from "./lobby.ts";
import { observeRoot } from "./telemetry.ts";

const params = new URLSearchParams(location.search);
const grid = document.querySelector<HTMLElement>("#instances")!;
const summary = document.querySelector<HTMLElement>("#summary")!;
const role = document.querySelector<HTMLElement>("#role")!;
const invite = document.querySelector<HTMLAnchorElement>("#invite")!;
let match = params.get("match") ?? "";

if (!/^[\w-]{1,32}$/u.test(match)) {
	match = crypto.randomUUID().slice(0, 8);
	params.set("match", match);
	history.replaceState(null, "", `?${params.toString()}`);
}

invite.href = location.href;

const lobby = await joinLobby(match);

role.textContent = `match ${match} · you are ${lobby.peer} (${lobby.role === "host" ? "hosting" : "joined"})`;
document.body.dataset["role"] = lobby.role;

if (lobby.role === "host") {
	const host = startHost({
		"settings": readSettings(location.search, { "clients": 1, "teams": 4 }),
		"matchId": match,
		"grid": grid,
		"status": document.querySelector<HTMLTableSectionElement>("#status tbody")!,
		"summary": summary
	});

	host.addInstance(lobby.peer);
	lobby.onPlayer((peer, channel) => {
		host.telemetry.log.info("player connected", { "peer": peer });
		host.attachRemote(peer, channel);
	});
} else {
	const hub = createHub({ "id": "page" });
	const telemetry = observeRoot(hub);
	const bots = params.get("bots") !== "0";
	let latest: InstanceView | undefined;
	const frame = createInstanceFrame(grid, { "id": lobby.peer, "matchId": match, "bots": bots }, (loaded) => {
		void lobby.connect().then((channel) => {
			// The host may debug this player's client only if this player has debugging on too (and the host does).
			const message: PortMessage = { "type": "netsim-port", "id": lobby.peer, "channel": channel, "remote": true, ...telemetry.tab === undefined ? {} : { "debugHost": "page" } };

			loaded.contentWindow!.postMessage(message, location.origin);
		});
	});

	// This tab's tree: page ─ instance ─ client worker (which also links, non-transit, to the host's referee).
	hub.link(windowTransport(frame.contentWindow!, location.origin));
	telemetry.log.info("joined", { "match": match, "peer": lobby.peer });
	hub.subscribe(instanceSubjects(lobby.peer).view, (data) => { latest = data as InstanceView; });
	lobby.onHostLeft(() => {
		telemetry.log.warn("the host left", { "match": match });
		document.body.dataset["hostLeft"] = "true";
	});
	setInterval(() => {
		summary.textContent = document.body.dataset["hostLeft"] === "true"
			? "the host left — reload to host or join again"
			: latest === undefined ? "joining…" : `team ${latest.team ?? "–"} · tick ${latest.viewTick} · ${latest.inSync ? "in sync" : "out of sync"}`;
	}, 250);

	/** For scripts and debugging. */
	(globalThis as unknown as { "__netsim": unknown }).__netsim = {
		"hub": hub,
		"logs": (source?: string) => telemetry.records.filter((record) => source === undefined || record.context?.["source"] === source),
		"architecture": () => telemetry.store.snapshot(),
		"tab": telemetry.tab,
		"view": () => latest
	};
}

/** For scripts: which match this tab is in, and as whom. */
(globalThis as unknown as { "__netsimPlay": unknown }).__netsimPlay = { "match": match, "role": lobby.role, "peer": lobby.peer };
