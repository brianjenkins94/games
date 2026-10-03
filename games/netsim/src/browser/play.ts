/**
 * Players in separate tabs (play.html?match=<id>): the first tab at a match hosts it — the referee, and its own player
 * (`player-0`) — and every tab of this origin that opens the same match after it joins as another player (whatever
 * page or path it was loaded from), its client linked to the host's referee over WebRTC, the two pages signaling
 * through the lobby (hub's joinLobby). Each tab is its own hub tree, observed on its own (its own tab in debug-mcp); the host's also serves
 * netsim's tools over the whole match.
 */
import type { InstanceView, PortMessage } from "./bootstrap.ts";
import type { RtcLink } from "@brianjenkins94/hub";
import { createHub, joinLobby, windowTransport } from "@brianjenkins94/hub";
import { instanceSubjects, readSettings } from "./bootstrap.ts";
import { createInstanceFrame, startHost } from "./host.ts";
import { observeApp } from "@brianjenkins94/observability";

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

// Observed first — every channel of this realm's, its lobby's BroadcastChannel and Web Locks included — then the lobby.
const hub = createHub({ "id": "page" });
const telemetry = observeApp(hub, { "network": true, "messages": true });
const lobby = await joinLobby("netsim", match);

role.textContent = `match ${match} · you are ${lobby.peer} (${lobby.role === "host" ? "hosting" : "joined"})`;
document.body.dataset["role"] = lobby.role;

if (lobby.role === "host") {
	const host = startHost({
		"observed": { "hub": hub, "telemetry": telemetry },
		"settings": readSettings(location.search, { "clients": 1, "teams": 4 }),
		"matchId": match,
		"grid": grid,
		"status": document.querySelector<HTMLTableSectionElement>("#status tbody")!,
		"summary": summary
	});

	host.addInstance(lobby.peer);
	lobby.onPlayer((peer, link) => {
		host.telemetry.log.info("player connected", { "peer": peer });
		host.attachRemote(peer, link);
	});
} else {
	const bots = params.get("bots") !== "0";
	let latest: InstanceView | undefined;
	// The client's end of its link, made here (its worker is in the instance frame), its data channel passed on to it.
	let link: RtcLink | undefined;
	const frame = createInstanceFrame(grid, { "id": lobby.peer, "matchId": match, "bots": bots }, (loaded) => {
		link?.close();
		void lobby.link((channel) => {
			loaded.contentWindow!.postMessage({ "type": "netsim-port", "channel": channel } satisfies PortMessage, location.origin, [channel as unknown as Transferable]);
		}).then((made) => { link = made; });
	});

	// This tab's tree: page ─ instance ─ client worker (which also links, non-transit, to the host's referee) — as the
	// host's own player's is.
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
