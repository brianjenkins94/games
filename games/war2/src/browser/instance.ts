/**
 * An instance page (one iframe per client): starts its client worker, hands it the channel to the referee the page
 * sends, draws what the worker reports with war2's Phaser renderer (render/renderer.ts), and turns input into intents
 * for the worker — a selection, and commands: right-click moves the selection, or sets a selected building's rally
 * point. The worker checks each command against its prediction before predicting and sending it (W3, see
 * MIGRATION.md).
 */
import type { RendererState } from "../render/renderer.ts";
import type { InstanceInput, InstanceView, PortMessage } from "./bootstrap.ts";
import { createHub, portTransport, windowTransport } from "@brianjenkins94/hub";
import { observe, ownWorker, scopedTransport } from "@brianjenkins94/observability";
import productionJson from "../assets/production.json" with { "type": "json" };
import { lookAt, setView, startRenderer, worldToScreen } from "../render/renderer.ts";
import { CmdType } from "../sim/command.ts";
import { instanceSubjects, seatKey } from "./bootstrap.ts";
import { loadGameMap } from "./maps.ts";

const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "client";
const tokenKey = seatKey(params.get("match") ?? "", id);
const local = instanceSubjects(id);
// Named under its client (`player-0/ui`), as the edge would name it: what's behind the client is under the client.
const hub = createHub({ "id": id + "/ui" });
const { log } = observe(hub, { "network": true, "messages": { "window": (source) => (source === parent ? "page" : undefined) } });
const worker = new Worker(new URL("client.worker.ts", import.meta.url), { "type": "module", "name": id });
const badge = document.querySelector<HTMLElement>("#badge")!;
const PRODUCTION = productionJson as Record<string, { "trains"?: string[] }>;
let latest: InstanceView | undefined;

ownWorker(worker, () => { log.error("worker failed to load", { "worker": id }); });
// This page made the worker, and names it on its link — the same id the page assigned at the referee — and, the
// worker's reports reaching its page through here, it's the edge that names them.
hub.link(scopedTransport(portTransport(worker), id, { "keep": (other) => other === hub.id || other === "referee" }), { "peer": id });

let linkedUp = false;

globalThis.addEventListener("message", (event: MessageEvent<PortMessage | undefined>) => {
	if (event.source === parent && event.data?.type === "war2-port") {
		const message: PortMessage = { "type": "war2-port", "channel": event.data.channel, "bots": params.get("bots") !== "0", ...storedToken() };

		// Its page is its tab's root: link up to it, so the tab observes (and debugs) its own client.
		if (!linkedUp) {
			linkedUp = true;
			hub.link(windowTransport(parent, location.origin));
		}

		// On to the worker at once: a data channel can be passed on only as it arrives.
		worker.postMessage(message, [message.channel as unknown as Transferable]);
	}
});

// Keep the seat token across a reload of this instance (sessionStorage: this tab only; may be unavailable).
function storedToken(): { "token"?: string } {
	try {
		const token = sessionStorage.getItem(tokenKey);

		return token === null ? {} : { "token": token };
	} catch {
		return {};
	}
}

let renderer: RendererState | undefined;
let starting = false;

function send(input: InstanceInput): void {
	hub.publish(local.input, input);
}

/** The renderer, once the first view names the map (loaded from the assets mirror if it isn't built in). */
async function start(view: InstanceView): Promise<void> {
	starting = true;

	const map = await loadGameMap(view.map!);

	renderer = await startRenderer(document.querySelector<HTMLElement>("#game")!, map, {
		"onSelect": (uids) => { send({ "action": "select", "uids": uids }); },
		"onSecondaryClick": (xFP, yFP, shift) => {
			const own = latest?.units.filter((unit) => unit.team === latest?.team) ?? [];
			const selected = own.filter((unit) => renderer.selected.has(unit.uid));
			const [building] = selected.length === 1 && selected[0].building !== undefined ? selected : [];

			if (building !== undefined) {
				if (PRODUCTION[building.type]?.trains !== undefined) {
					send({ "action": "command", "command": { "type": CmdType.SET_RALLY, "buildingUid": building.uid, "txFP": xFP, "tyFP": yFP } });
				}
			} else if (selected.length > 0) {
				send({ "action": "command", "command": { "type": CmdType.MOVE, "unitIds": selected.map((unit) => unit.uid), "txFP": xFP, "tyFP": yFP, ...shift ? { "queue": true } : {} } });
			}
		}
	});
	log.info("renderer started", { "map": map.name });
}

hub.subscribe(local.view, (data) => {
	latest = data as InstanceView;
	badge.textContent = `${id} · team ${latest.team} · tick ${latest.viewTick} · ${latest.inSync ? "in sync" : "out of sync"}`;
	badge.dataset["sync"] = String(latest.inSync);

	if (renderer !== undefined) {
		setView(renderer, latest);
	} else if (!starting && latest.map !== undefined) {
		void start(latest).catch((error: unknown) => { log.error("renderer failed", { "error": error instanceof Error ? error.message : String(error) }); });
	}

	if (latest.token !== undefined && latest.token !== storedToken().token) {
		try {
			sessionStorage.setItem(tokenKey, latest.token);
		} catch { /* no storage: a reload takes a new seat, if one's free */ }
	}
});

/** For scripts and debugging: what this instance last drew, and where a world point is on screen. */
(globalThis as unknown as { "__war2Instance": unknown }).__war2Instance = {
	"id": id,
	"latest": () => latest,
	"ready": () => renderer !== undefined && latest !== undefined,
	"selected": () => [...renderer?.selected ?? []],
	/** What the renderer has up: unit and building sprites, and whether the map's tileset loaded. */
	"drawn": () => (renderer === undefined ? undefined : { "units": renderer.unitSprites.size, "buildings": renderer.buildingSprites.size, "tileset": renderer.scene.textures.exists(renderer.tileset) }),
	"toScreen": (xFP: number, yFP: number) => (renderer === undefined ? undefined : worldToScreen(renderer, xFP, yFP)),
	"lookAt": (xFP: number, yFP: number) => { if (renderer !== undefined) { lookAt(renderer, xFP, yFP); } }
};
