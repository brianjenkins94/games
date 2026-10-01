/**
 * An instance page (one iframe per client): starts its client worker, hands it the channel to the referee the page
 * sends, draws what the worker reports, and turns clicks into input (left: select your nearest unit, right: move it).
 */
import type { InstanceInput, InstanceView, PortMessage } from "./bootstrap.ts";
import { createHub, portTransport, windowTransport } from "@brianjenkins94/hub";
import { decodeUnit, FP } from "../sim/index.ts";
import { instanceSubjects, seatKey } from "./bootstrap.ts";
import { observe, ownWorker, scopedTransport } from "@brianjenkins94/observability";

const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "client";
const tokenKey = seatKey(params.get("match") ?? "", id);
const local = instanceSubjects(id);
// Named under its client (`client-0/ui`), as the edge would name it: what's behind the client is under the client.
const hub = createHub({ "id": id + "/ui" });
// Every channel of this realm's, past its hub too — its worker's messages, the page's messages to it (from the page's hub,
// `page`), sockets, BroadcastChannels. Before the worker starts, so its probe sees it.
const { log } = observe(hub, { "network": true, "messages": { "window": (source) => (source === parent ? "page" : undefined) } });
const worker = new Worker(new URL("client.worker.ts", import.meta.url), { "type": "module", "name": id });
const canvas = document.querySelector("canvas")!;
const context = canvas.getContext("2d")!;
const TEAM_COLORS = ["#4f8cff", "#ff5f56", "#3ecf6e", "#f5b83d", "#b76cff", "#39c6d6"];
let latest: InstanceView | undefined;

ownWorker(worker, () => { log.error("worker failed to load", { "worker": id }); });
// This page made the worker, and names it on its link — the same id the page assigned at the referee — and, the
// worker's reports reaching its page through here, it's the edge that names them: the worker as `client-0`. What they
// name outside the client — this page, the referee its game links to — keeps its name.
hub.link(scopedTransport(portTransport(worker), id, { "keep": (other) => other === hub.id || other === "referee" }), { "peer": id });

let linkedUp = false;

globalThis.addEventListener("message", (event: MessageEvent<PortMessage | undefined>) => {
	if (event.source === parent && event.data?.type === "netsim-port") {
		const message: PortMessage = { "type": "netsim-port", "channel": event.data.channel, "bots": params.get("bots") !== "0", ...storedToken() };

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

function toWorld(event: MouseEvent): { "x": number; "y": number } | undefined {
	if (latest?.config === undefined) {
		return undefined;
	}

	const box = canvas.getBoundingClientRect();

	return { "x": ((event.clientX - box.left) / box.width) * latest.config.width * FP, "y": ((event.clientY - box.top) / box.height) * latest.config.height * FP };
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
	context.fillStyle = "#101418";
	context.fillRect(0, 0, canvas.width, canvas.height);

	const view = latest;

	if (view?.config !== undefined) {
		const scale = canvas.width / (view.config.width * FP);
		const predicted = view.predicted.map(decodeUnit);

		context.setTransform(scale, 0, 0, scale, 0, 0);

		// Fog: only what's within sight of a (predicted) own unit is lit.
		context.fillStyle = "#1d2630";

		for (const unit of predicted) {
			context.beginPath();
			context.arc(unit.x, unit.y, view.config.sight, 0, Math.PI * 2);
			context.fill();
		}

		for (const unit of view.units.map(decodeUnit)) {
			const color = TEAM_COLORS[unit.team % TEAM_COLORS.length];

			context.strokeStyle = color;
			context.lineWidth = FP * 0.08;

			if (unit.team === view.team) {
				// Own unit: authority as an outline; its target as a faint line.
				context.globalAlpha = 0.35;
				context.beginPath();
				context.moveTo(unit.x, unit.y);
				context.lineTo(unit.tx, unit.ty);
				context.stroke();
				context.globalAlpha = 1;
				context.beginPath();
				context.arc(unit.x, unit.y, FP * 0.35, 0, Math.PI * 2);
				context.stroke();
			} else {
				context.fillStyle = color;
				context.beginPath();
				context.arc(unit.x, unit.y, FP * 0.3, 0, Math.PI * 2);
				context.fill();
			}
		}

		for (const unit of predicted) {
			context.fillStyle = TEAM_COLORS[unit.team % TEAM_COLORS.length];
			context.beginPath();
			context.arc(unit.x, unit.y, FP * 0.25, 0, Math.PI * 2);
			context.fill();

			if (unit.id === view.selected) {
				context.strokeStyle = "#ffffff";
				context.lineWidth = FP * 0.06;
				context.beginPath();
				context.arc(unit.x, unit.y, FP * 0.5, 0, Math.PI * 2);
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
(globalThis as unknown as { "__netsimInstance": unknown }).__netsimInstance = { "id": id, "latest": () => latest };
