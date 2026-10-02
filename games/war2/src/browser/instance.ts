/**
 * An instance page (one iframe per client): starts its client worker, hands it the channel to the referee the page
 * sends, draws what the worker reports, and turns clicks into input (left: select your unit, right: move it).
 *
 * The drawing is a plain debug canvas — terrain, fog, units — until the Phaser renderer lands (W3, see MIGRATION.md).
 * Fog comes from the worker: what its team has explored, and what it can see now (within sight of its own units).
 */
import type { InstanceInput, InstanceView, PortMessage } from "./bootstrap.ts";
import { createHub, portTransport, windowTransport } from "@brianjenkins94/hub";
import { observe, ownWorker, scopedTransport } from "@brianjenkins94/observability";
import { FP, TILE_PX } from "../sim/components.ts";
import { inRange } from "../sim/distance.ts";
import { unitSight, unitTypeId } from "../sim/unitTypes.ts";
import { instanceSubjects, seatKey } from "./bootstrap.ts";
import { loadMap } from "./maps.ts";

const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "client";
const tokenKey = seatKey(params.get("match") ?? "", id);
const local = instanceSubjects(id);
// Named under its client (`player-0/ui`), as the edge would name it: what's behind the client is under the client.
const hub = createHub({ "id": id + "/ui" });
const { log } = observe(hub, { "network": true, "messages": { "window": (source) => (source === parent ? "page" : undefined) } });
const worker = new Worker(new URL("client.worker.ts", import.meta.url), { "type": "module", "name": id });
const canvas = document.querySelector("canvas")!;
const context = canvas.getContext("2d")!;
const TEAM_COLORS = ["#4f8cff", "#ff5f56", "#3ecf6e", "#f5b83d", "#b76cff", "#39c6d6"];
const TILE_FP = TILE_PX * FP;
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

hub.subscribe(local.view, (data) => {
	latest = data as InstanceView;

	if (latest.token !== undefined && latest.token !== storedToken().token) {
		try {
			sessionStorage.setItem(tokenKey, latest.token);
		} catch { /* no storage: a reload takes a new seat, if one's free */ }
	}
});

/** The map's size in tiles (from its name; loaded once). */
let map: { "name": string; "w": number; "h": number; "pass": number[] } | undefined;

function mapOf(view: InstanceView): typeof map {
	if (view.map !== undefined && map?.name !== view.map) {
		const info = loadMap(view.map);

		map = { "name": view.map, "w": info.mapW, "h": info.mapH, "pass": info.gids.map((gid) => (gid === 0 ? 1 : 0)) };
	}

	return map;
}

function toWorld(event: MouseEvent): { "x": number; "y": number } | undefined {
	const current = latest === undefined ? undefined : mapOf(latest);

	if (current === undefined) {
		return undefined;
	}

	const box = canvas.getBoundingClientRect();

	return { "x": ((event.clientX - box.left) / box.width) * current.w * TILE_FP, "y": ((event.clientY - box.top) / box.height) * current.h * TILE_FP };
}

canvas.addEventListener("mousedown", (event) => {
	const point = toWorld(event);

	if (point !== undefined) {
		hub.publish(local.input, { "action": event.button === 2 ? "move" : "select", ...point } satisfies InstanceInput);
	}
});
canvas.addEventListener("contextmenu", (event) => { event.preventDefault(); });

function draw(): void {
	const { width, height } = canvas.getBoundingClientRect();

	if (canvas.width !== Math.round(width * devicePixelRatio)) {
		canvas.width = Math.round(width * devicePixelRatio);
		canvas.height = Math.round(height * devicePixelRatio);
	}

	context.setTransform(1, 0, 0, 1, 0, 0);
	context.fillStyle = "#05070a";
	context.fillRect(0, 0, canvas.width, canvas.height);

	const view = latest;
	const current = view === undefined ? undefined : mapOf(view);

	if (view !== undefined && current !== undefined) {
		const scale = canvas.width / (current.w * TILE_FP);
		const explored = new Uint8Array(current.w * current.h);

		for (let index = 0; index < view.explored.length; index += 2) {
			explored.fill(1, view.explored[index], view.explored[index] + view.explored[index + 1]);
		}

		const sight = (tx: number, ty: number): boolean => view.predicted.some((unit) => inRange(Math.floor(unit.x / TILE_FP) - tx, Math.floor(unit.y / TILE_FP) - ty, unitSight(unitTypeId(unit.type))));

		context.setTransform(scale, 0, 0, scale, 0, 0);

		// Terrain, under fog: unexplored is black; explored is drawn, dimmed where nothing of ours sees it now.
		for (let ty = 0; ty < current.h; ty += 1) {
			for (let tx = 0; tx < current.w; tx += 1) {
				if (explored[ty * current.w + tx] === 0) {
					continue;
				}

				const lit = sight(tx, ty);

				context.fillStyle = current.pass[ty * current.w + tx] === 1 ? (lit ? "#4a3b2c" : "#2a2219") : (lit ? "#1f3324" : "#141f17");
				context.fillRect(tx * TILE_FP, ty * TILE_FP, TILE_FP, TILE_FP);
			}
		}

		for (const unit of view.units) {
			const color = TEAM_COLORS[unit.team % TEAM_COLORS.length];

			context.strokeStyle = color;
			context.lineWidth = TILE_FP * 0.06;

			if (unit.team === view.team) {
				// Own unit: authority as an outline (the prediction, filled, is drawn over it).
				context.beginPath();
				context.arc(unit.x, unit.y, TILE_FP * 0.4, 0, Math.PI * 2);
				context.stroke();
			} else {
				context.fillStyle = color;
				context.beginPath();
				context.arc(unit.x, unit.y, TILE_FP * 0.35, 0, Math.PI * 2);
				context.fill();
			}
		}

		for (const unit of view.predicted) {
			context.fillStyle = TEAM_COLORS[unit.team % TEAM_COLORS.length];
			context.beginPath();
			context.arc(unit.x, unit.y, TILE_FP * 0.3, 0, Math.PI * 2);
			context.fill();

			if (unit.target !== undefined) {
				context.strokeStyle = "rgba(255, 255, 255, 0.25)";
				context.lineWidth = TILE_FP * 0.04;
				context.beginPath();
				context.moveTo(unit.x, unit.y);
				context.lineTo(unit.target[0], unit.target[1]);
				context.stroke();
			}

			if (view.selected.includes(unit.uid)) {
				context.strokeStyle = "#ffffff";
				context.lineWidth = TILE_FP * 0.05;
				context.beginPath();
				context.arc(unit.x, unit.y, TILE_FP * 0.5, 0, Math.PI * 2);
				context.stroke();
			}
		}
	}

	context.setTransform(1, 0, 0, 1, 0, 0);
	context.font = `${12 * devicePixelRatio}px ui-monospace, monospace`;
	context.fillStyle = view?.inSync === true ? "#9fe6b8" : "#ffb4a8";
	context.fillText(view === undefined ? `${id} · connecting` : `${id} · team ${view.team} · tick ${view.viewTick} · ${view.inSync ? "in sync" : "out of sync"}`, 8 * devicePixelRatio, 18 * devicePixelRatio);
	requestAnimationFrame(draw);
}

requestAnimationFrame(draw);

/** For scripts and debugging: what this instance last drew, as data. */
(globalThis as unknown as { "__war2Instance": unknown }).__war2Instance = { "id": id, "latest": () => latest };
