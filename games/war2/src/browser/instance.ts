/**
 * An instance page (one iframe per client): starts its client worker, hands it the channel to the referee the page
 * sends, draws what the worker reports with war2's Phaser renderer and HUD (render/), and turns input into intents for
 * the worker — the selection, and commands. What input means is the command-card controller's (ui/): right-click moves
 * the selection or sets a building's rally point, the card's slots and hotkeys arm moves, open the build menu, place
 * buildings, train units; the status strip cancels production. The worker checks each command against its prediction
 * before predicting and sending it (W3, see MIGRATION.md).
 */
import type { Hud } from "../render/hud.ts";
import type { RendererState } from "../render/renderer.ts";
import type { Command } from "../sim/command.ts";
import type { CommandCardController } from "../ui/commandCardController.ts";
import type { Terrain } from "../sim/passability.ts";
import type { GameMap } from "../maps.ts";
import type { InstanceInput, PortMessage } from "./contract.ts";
import type { InstanceView, UnitInfo } from "../net/view.ts";
import { createHub, portTransport, windowTransport } from "@brianjenkins94/hub";
import { observe, ownWorker, reportMetrics, scopedTransport } from "@brianjenkins94/observability";
import productionJson from "../data/production.json" with { "type": "json" };
import { createHud } from "../render/hud.ts";
import { lookAt, setGhost, setTargetingCursor, setView, startRenderer, worldToScreen } from "../render/renderer.ts";
import { CmdType } from "../sim/command.ts";
import { fpToTile, snapWalkFP } from "../sim/components.ts";
import { buildTerrain, terrainFits } from "../sim/passability.ts";
import { unitFootprint, unitTypeId } from "../sim/unitTypes.ts";
import { createCommandCardController } from "../ui/commandCardController.ts";
import { instanceSubjects, seatKey } from "./contract.ts";
import { loadGameMap } from "../maps.ts";
import { frameRateGauge, heapGauge } from "./metrics.ts";

const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "client";
const tokenKey = seatKey(params.get("match") ?? "", id);
const local = instanceSubjects(id);
// Named under its client (`player-0/ui`), as the edge would name it: what's behind the client is under the client.
const hub = createHub({ "id": id + "/ui" });
const { log } = observe(hub, { "network": true, "messages": { "window": (source) => (source === parent ? "page" : undefined) } });
const worker = new Worker(new URL("client.worker.ts", import.meta.url), { "type": "module", "name": id });
// Its gauges (metrics.ts): the rate it draws at, and its heap.
const metrics = reportMetrics(hub);

metrics.gauge("fps", frameRateGauge());
metrics.gauge("heap", heapGauge());
const badge = document.querySelector<HTMLElement>("#badge")!;
const PRODUCTION = productionJson as Record<string, { "trains"?: string[] }>;
let latest: InstanceView | undefined;

ownWorker(worker, () => { log.error("worker failed to load", { "worker": id }); });
// This page made the worker, and names it on its link — the same id the page assigned at the referee — and, the
// worker's reports reaching its page through here, it's the edge that names them.
hub.link(scopedTransport(portTransport(worker), id, { "keep": (other) => other === hub.id || other === "referee" }), { "peer": id });

// Its page is its tab's root: link up to it at once, so the tab observes (and debugs) its own client — whether or not
// a link to the referee ever comes. (Opened on its own, it has no page.)
if (parent !== globalThis.window) {
	hub.link(windowTransport(parent, location.origin));
}

globalThis.addEventListener("message", (event: MessageEvent<PortMessage | undefined>) => {
	if (event.source === parent && event.data?.type === "war2-port") {
		const message: PortMessage = { "type": "war2-port", "channel": event.data.channel, "bots": params.get("bots") !== "0", ...storedToken() };

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
let gameMap: GameMap | undefined;
let hud: Hud | undefined;
let card: CommandCardController | undefined;
let starting = false;

function send(input: InstanceInput): void {
	hub.publish(local.input, input);
}

function emit(command: Command): void {
	send({ "action": "command", "command": command });
}

/** The selected units that are this player's own, as the view has them (queues included). */
function ownSelection(): UnitInfo[] {
	return latest?.units.filter((unit) => unit.team === latest?.team && renderer?.selected.has(unit.uid)) ?? [];
}

/** The selected building, if exactly one is selected and it trains something (a right-click sets its rally). */
function rallyableBuilding(): number | undefined {
	const selected = ownSelection();

	return selected.length === 1 && selected[0].building !== undefined && PRODUCTION[selected[0].type]?.trains !== undefined ? selected[0].uid : undefined;
}

/** Each map's terrain, as the sim reads it (passability.ts), worked out once. */
const terrains = new WeakMap<GameMap, Terrain>();

/** Placement, advisory (the referee re-checks it, as the deterministic source of truth — world.ts canPlaceBuilding): the
 *  sim's terrain rule (passability.ts terrainFits), and clear of the buildings the team can see. */
function canPlace(map: GameMap, tileX: number, tileY: number, typeId: number): boolean {
	const [fw, fh] = unitFootprint(typeId);
	const { gids, mapW, mapH, terrainArr } = map.info;
	let terrain = terrains.get(map);

	if (terrain === undefined) {
		terrain = buildTerrain(gids, mapW, mapH, terrainArr);
		terrains.set(map, terrain);
	}

	if (!terrainFits(terrain, tileX, tileY, fw, fh)) {
		return false;
	}

	for (const unit of latest?.units ?? []) {
		if (unit.building !== undefined) {
			const { w, h } = unit.building;
			const [left, top] = [fpToTile(unit.x) - (w >> 1), fpToTile(unit.y) - (h >> 1)];

			// Overlapping footprints: the two rectangles intersect.
			if (left < tileX + fw && tileX < left + w && top < tileY + fh && tileY < top + h) {
				return false;
			}
		}
	}

	return true;
}

/** The HUD for the current selection: the card for its first unit's type, its queue in the status strip, its
 *  portrait. */
function refreshHud(selectionChanged: boolean): void {
	const selected = ownSelection();
	const [primary] = selected;

	if (selectionChanged) {
		card?.setSelection(primary?.type ?? null);
	}

	hud?.showPortrait(primary?.type, selected.length);

	if (primary?.production !== undefined && primary.production.queue.length > 0) {
		hud?.showStatus({ "kind": "production", "items": primary.production.queue, "ticksLeft": primary.production.ticksLeft, "ticksTotal": primary.production.ticksTotal });
	} else if (primary?.orders !== undefined && primary.orders.length > 0) {
		hud?.showStatus({ "kind": "orders", "count": primary.orders.length });
	} else {
		hud?.showStatus(undefined);
	}
}

/** The renderer, HUD and card, once the first view names the map (loaded from the assets mirror if it isn't built
 *  in) and the team. */
async function start(view: InstanceView): Promise<void> {
	starting = true;

	const map = await loadGameMap(view.map!);
	const team = view.team!;

	gameMap = map;

	hud = createHud(document, map.render.tileset, {
		"onSlot": (index) => { card?.slot(index); },
		"onProductionCancel": (index) => {
			const building = ownSelection()[0];

			if (building !== undefined) {
				emit({ "type": CmdType.CANCEL_PRODUCE, "buildingUid": building.uid, "index": index, "team": team });
			}
		}
	});
	renderer = await startRenderer(document.querySelector<HTMLElement>("#game")!, map, {
		"onSelect": (uids) => {
			send({ "action": "select", "uids": uids });
			refreshHud(true);
		},
		"onPrimaryClick": (xFP, yFP) => card?.primaryClick(xFP, yFP) ?? false,
		"onSecondaryClick": (xFP, yFP, shift) => { card?.secondaryClick(xFP, yFP, shift); },
		"onHover": (xFP, yFP) => { card?.hoverTile(xFP, yFP); },
		"onHotkey": (letter) => card?.hotkey(letter) ?? false,
		"onEscape": () => { card?.escape(); },
		"onDrag": (dragging, overCard) => {
			hud?.setDragMode(dragging);
			hud?.setCardFaded(dragging && overCard);
		}
	});
	card = createCommandCardController({
		"getOwnSelection": () => ownSelection().map((unit) => unit.uid),
		"getRallyableBuildingUid": rallyableBuilding,
		// The sim rests units on its 8px grid, so a click anchors there (sub-tile), not on the 32px lattice.
		"snapToTile": snapWalkFP,
		"emit": emit,
		"render": (shown) => { hud?.showCard(shown); },
		"setTargetingCursor": (on) => { setTargetingCursor(renderer, on); },
		"log": (message) => { log.info(message); },
		"myTeam": team,
		"fpToTile": fpToTile,
		"canPlaceBuilding": (tileX, tileY, typeId) => canPlace(map, tileX, tileY, typeId),
		"showPlacementGhost": (ghost) => { setGhost(renderer, ghost); }
	});
	log.info("renderer started", { "map": map.name });
}

hub.subscribe(local.view, (data) => {
	latest = data as InstanceView;
	badge.textContent = `${id} · team ${latest.team} · tick ${latest.viewTick} · ${latest.inSync ? "in sync" : "out of sync"}`;
	badge.dataset["sync"] = String(latest.inSync);

	if (renderer !== undefined) {
		setView(renderer, latest);
		refreshHud(false);
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
	/** The command card as shown: each slot's ability id (null for an empty slot), or null for no card. */
	"card": () => {
		const element = document.querySelector<HTMLElement>("#hud-card")!;

		return element.style.display === "grid" ? [...element.children].map((cell) => (cell as HTMLElement).dataset["ability"] ?? null) : null;
	},
	/** What the renderer has up: unit and building sprites, and whether the map's tileset loaded. */
	"drawn": () => (renderer === undefined ? undefined : { "units": renderer.unitSprites.size, "buildings": renderer.buildingSprites.size, "tileset": renderer.scene.textures.exists(renderer.tileset) }),
	/** Whether a building of `type` may go at footprint top-left (tileX, tileY), as the placement ghost judges it. */
	"canPlace": (tileX: number, tileY: number, type: string) => gameMap !== undefined && canPlace(gameMap, tileX, tileY, unitTypeId(type)),
	"toScreen": (xFP: number, yFP: number) => (renderer === undefined ? undefined : worldToScreen(renderer, xFP, yFP)),
	"lookAt": (xFP: number, yFP: number) => { if (renderer !== undefined) { lookAt(renderer, xFP, yFP); } }
};
