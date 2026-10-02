/**
 * The HUD — wiring for the static DOM overlay declared in instance.html (resource bar, status strip, portrait, command
 * card): grabs refs and fills the dynamic bits. The layout is declarative HTML/CSS. Carried from the old war2's
 * renderer (W3, see MIGRATION.md), its refs in a HUD object of its own rather than on the renderer's state, and the
 * portrait — empty before — showing the selection.
 */
import type { CommandCard } from "../ui/abilities.ts";
import iconsJson from "../assets/icons.json" with { "type": "json" };
import { assetUrl } from "../browser/assets.ts";

// Icon sheet geometry: 46×38 frames in a 5-column grid.
const ICON_W = (iconsJson as { "frameWidth": number }).frameWidth;
const ICON_H = (iconsJson as { "frameHeight": number }).frameHeight;
const ICON_COLS = 5;
const ICON_FRAMES = (iconsJson as { "frames": Record<string, number> }).frames;

/** The tileset's icon sheet (each tileset has its own; Tiled's "summer" is the mirror's too). */
function iconsUrl(tileset: string): string {
	return assetUrl(`graphics/tilesets/${["winter", "summer", "wasteland", "swamp"].includes(tileset) ? tileset : "summer"}/icons.png`);
}

/** CSS background-position that crops the icon sheet to an icon-frame key, at `scale`. */
function iconPosition(key: string, scale = 1): string {
	const index = ICON_FRAMES[key] ?? ICON_FRAMES["icon-cancel"] ?? 0;

	return `-${(index % ICON_COLS) * ICON_W * scale}px -${Math.floor(index / ICON_COLS) * ICON_H * scale}px`;
}

/** A unit type's icon key: icon-<name>, else the placeholder. */
export function unitIconKey(type: string): string {
	const key = "icon-" + type.replace(/^unit-/u, "");

	return key in ICON_FRAMES ? key : "icon-cancel";
}

/** The selection's queue, for the status strip. */
export type StatusView =
	| { "kind": "production"; "items": string[]; "ticksLeft": number; "ticksTotal": number }
	| { "kind": "orders"; "count": number }
	| undefined;

export interface HudCallbacks {
	/** A card slot was clicked. */
	"onSlot": (index: number) => void;
	/** A production item was clicked (cancel it). */
	"onProductionCancel": (index: number) => void;
}

export interface Hud {
	"showCard": (card: CommandCard | null) => void;
	"showStatus": (status: StatusView) => void;
	/** The selection's portrait: its type's icon and name, and how many are selected. */
	"showPortrait": (type: string | undefined, count: number) => void;
	"showResources": (text: string) => void;
	/** While a drag-select is on, the chrome lets the pointer through (so the drag keeps tracking across it). */
	"setDragMode": (on: boolean) => void;
	/** The card fades while a drag sweeps over it. */
	"setCardFaded": (faded: boolean) => void;
}

function icon(url: string, key: string, scale = 1): HTMLDivElement {
	const cell = document.createElement("div");

	Object.assign(cell.style, {
		"width": `${Math.round(ICON_W * scale)}px`,
		"height": `${Math.round(ICON_H * scale)}px`,
		"position": "relative",
		"boxSizing": "border-box",
		"backgroundImage": `url("${url}")`,
		"backgroundPosition": iconPosition(key, scale),
		"backgroundSize": `${ICON_W * ICON_COLS * scale}px auto`,
		"backgroundRepeat": "no-repeat",
		"imageRendering": "pixelated"
	});

	return cell;
}

export function createHud(root: ParentNode, tileset: string, callbacks: HudCallbacks): Hud {
	const url = iconsUrl(tileset);
	const card = root.querySelector<HTMLDivElement>("#hud-card")!;
	const status = root.querySelector<HTMLDivElement>(".hud-status")!;
	const portrait = root.querySelector<HTMLDivElement>("#hud-portrait")!;
	const resources = root.querySelector<HTMLDivElement>("#hud-resources")!;
	const chrome = [...root.querySelectorAll<HTMLDivElement>(".hud-chrome")];

	// Right-click on the chrome shouldn't pop the browser's context menu.
	root.querySelector("#hud")?.addEventListener("contextmenu", (event) => { event.preventDefault(); });

	return {
		"showCard": (shown) => {
			card.replaceChildren();

			if (shown === null) {
				card.style.display = "none";

				return;
			}

			card.style.display = "grid";

			for (const [index, ability] of shown.entries()) {
				if (ability === null) {
					const empty = document.createElement("div");

					Object.assign(empty.style, { "border": "1px solid rgba(255,255,255,0.10)", "background": "rgba(0,0,0,0.25)" });
					card.append(empty);

					continue;
				}

				const cell = icon(url, ability.icon);

				Object.assign(cell.style, { "border": "1px solid #2a4", "cursor": "pointer" });
				cell.title = ability.hotkey.length === 1 ? `${ability.label} (${ability.hotkey})` : ability.label;
				cell.dataset["ability"] = ability.id;

				if (ability.hotkey.length === 1) {
					const key = document.createElement("span");

					key.textContent = ability.hotkey;
					Object.assign(key.style, { "position": "absolute", "left": "1px", "bottom": "0px", "font": "bold 10px monospace", "color": "#ff4", "textShadow": "0 0 2px #000, 0 0 2px #000", "pointerEvents": "none" });
					cell.append(key);
				}

				cell.addEventListener("click", () => { callbacks.onSlot(index); });
				card.append(cell);
			}
		},
		"showStatus": (view) => {
			status.replaceChildren();

			if (view === undefined) {
				return;
			}

			if (view.kind === "orders") {
				const label = document.createElement("div");

				label.textContent = `Queued: ${view.count} step${view.count === 1 ? "" : "s"}`;
				Object.assign(label.style, { "font": "11px monospace", "color": "#cde", "padding": "2px 6px" });
				status.append(label);

				return;
			}

			// The strip is short (a quarter of the bottom cell), so product icons are scaled down to fit.
			const scale = 26 / ICON_H;

			for (const [index, type] of view.items.entries()) {
				const cell = icon(url, unitIconKey(type), scale);

				Object.assign(cell.style, { "border": "1px solid #2a4", "cursor": "pointer", "marginRight": "2px" });
				cell.title = "Cancel " + type.replace(/^unit-/u, "");
				cell.dataset["production"] = String(index);

				if (index === 0 && view.ticksTotal > 0) {
					const bar = document.createElement("div");

					Object.assign(bar.style, { "position": "absolute", "left": "0", "bottom": "0", "height": "3px", "width": `${Math.round(((view.ticksTotal - view.ticksLeft) / view.ticksTotal) * 100)}%`, "background": "#4f4" });
					cell.append(bar);
				}

				cell.addEventListener("click", () => { callbacks.onProductionCancel(index); });
				status.append(cell);
			}
		},
		"showPortrait": (type, count) => {
			portrait.replaceChildren();

			if (type === undefined) {
				return;
			}

			const label = document.createElement("div");

			label.textContent = type.replace(/^unit-/u, "").replaceAll("-", " ") + (count > 1 ? ` ×${count}` : "");
			Object.assign(label.style, { "marginLeft": "8px", "textTransform": "capitalize" });
			portrait.append(icon(url, unitIconKey(type)), label);
		},
		"showResources": (text) => { resources.textContent = text; },
		"setDragMode": (on) => {
			for (const cell of chrome) {
				cell.style.pointerEvents = on ? "none" : "auto";
			}

			if (!on) {
				card.style.opacity = "1";
			}
		},
		"setCardFaded": (faded) => { card.style.opacity = faded ? "0.2" : "1"; }
	};
}
