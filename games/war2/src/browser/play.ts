/**
 * Players in separate tabs (play.html?match=<id>; netsim's, W3 — see MIGRATION.md): the first tab at a match hosts it
 * — the referee, and its own player (`player-0`) — and every tab of this origin that opens the same match after it
 * joins as another player (whatever page or path it was loaded from), its client linked to the host's referee over
 * WebRTC, the two pages signaling through the lobby (lobby.ts, rtc.ts). With `&lobby=peerjs` the tabs can be on other
 * machines: they meet through PeerJS's broker and link over its peer connections instead (peerLobby.ts). Each tab is
 * its own hub tree, observed on its own (its own tab in debug-mcp); the host's also serves war2's tools over the whole
 * match.
 */
import type { InstanceView, PortMessage } from "./bootstrap.ts";
import { createHub, windowTransport } from "@brianjenkins94/hub";
import { observeApp } from "@brianjenkins94/observability";
import { instanceSubjects, readSettings } from "./bootstrap.ts";
import { createInstanceFrame, startHost } from "./host.ts";
import { joinLobby } from "./lobby.ts";

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
// Tabs of one browser meet through the local lobby; `?lobby=peerjs` meets players on other machines through PeerJS
// (`&broker=host:port` for a broker of our own, `&ice=none` for no STUN/TURN — two ends on one machine).
const online = params.get("lobby") === "peerjs";
// (PeerJS is imported only then: it opens a test peer connection the moment it loads — the zero-knowledge probes saw
// it in every tab.)
const lobby = online ? await (await import("./peerLobby.ts")).joinPeerLobby(match, { ...params.has("broker") ? { "broker": params.get("broker")! } : {}, ...params.get("ice") === "none" ? { "iceServers": [] } : {} }) : await joinLobby(match);

role.textContent = `match ${match} · you are ${lobby.peer} (${lobby.role === "host" ? "hosting" : "joined"}${online ? ", online — send the link to another machine" : ""})`;
document.body.dataset["role"] = lobby.role;

if (lobby.role === "host") {
	const host = startHost({
		"observed": { "hub": hub, "telemetry": telemetry },
		"settings": readSettings(location.search, { "clients": 1, "teams": 2 }),
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
	let link: { "close": () => void } | undefined;
	const frame = createInstanceFrame(grid, { "id": lobby.peer, "matchId": match, "bots": bots }, (loaded) => {
		link?.close();
		void lobby.link((channel) => {
			loaded.contentWindow!.postMessage({ "type": "war2-port", "channel": channel } satisfies PortMessage, location.origin, [channel as unknown as Transferable]);
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
	(globalThis as unknown as { "__war2": unknown }).__war2 = {
		"hub": hub,
		"logs": (source?: string) => telemetry.records.filter((record) => source === undefined || record.context?.["source"] === source),
		"architecture": () => telemetry.store.snapshot(),
		"tab": telemetry.tab,
		"view": () => latest
	};
}

/** For scripts: which match this tab is in, and as whom. */
(globalThis as unknown as { "__war2Play": unknown }).__war2Play = { "match": match, "role": lobby.role, "peer": lobby.peer };
