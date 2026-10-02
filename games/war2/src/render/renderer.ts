/**
 * war2's Phaser renderer, in an instance page: draws what its client worker reports (the team's view, its prediction,
 * what it has explored) and turns input into intents — a selection, a right-click — for the page to send back. No game
 * logic, no sim state: only the view. Carried from the old war2's renderer (W3, see MIGRATION.md), with its state in
 * one object per scene, its terrain in streamed chunks with Stratagus-style fog edges (ChunkRenderer), sprites loaded
 * lazily from the assets mirror (sprites.ts), and a minimap.
 *
 * Fixed on the way over (the audit's rendering findings): fog is drawn from the worker's view, computed once, not
 * recomputed over the whole map per frame; selection hit-tests where units are drawn, not their raw positions; a drag
 * box rings only your own units.
 *
 * Coordinate spaces: screen (pixels from the canvas's top-left: pointer events), world (pixels from the map's
 * top-left: where units are drawn), FP (world × FP: the sim's fixed point).
 */
import type { InstanceView, UnitInfo } from "../browser/bootstrap.ts";
import type { GameMap } from "../browser/maps.ts";
import Phaser from "phaser";
import { FP, TILE_PX } from "../sim/components.ts";
import { unitBoxHalfPx, unitTypeId } from "../sim/unitTypes.ts";
import { ChunkRenderer } from "./ChunkRenderer.ts";
import { computeFog, VISIBLE } from "./fog.ts";
import { Minimap } from "./Minimap.ts";
import { drawEntities } from "./units.ts";

// The HUD's chrome (instance.html: --ui-*): the minimap fills the bottom-left cell, the card the bottom-right.
const MINIMAP_SIZE = 120;
const UI_RIGHT = 150;
const UI_BOTTOM = 120;
const CAM_SPEED = 8;
const TICK_MS = 50;

export interface RendererCallbacks {
	/** The selection changed (stable unit ids: own units only). */
	"onSelect": (uids: number[]) => void;
	/** A left-click on the map, in FP, before it selects: true if it was taken (an armed ability's target, a
	 *  building's placement), and so doesn't change the selection. */
	"onPrimaryClick"?: (xFP: number, yFP: number) => boolean;
	/** A right-click on the map, in FP (shift: queue it). */
	"onSecondaryClick": (xFP: number, yFP: number, shift: boolean) => void;
	/** The pointer moved over the map, in FP (drives the placement ghost). */
	"onHover"?: (xFP: number, yFP: number) => void;
	/** A letter key: true if it was a command-card hotkey. */
	"onHotkey"?: (letter: string) => boolean;
	"onEscape"?: () => void;
	/** A drag-select started or ended (the HUD lets the pointer through meanwhile), and whether it's over the card. */
	"onDrag"?: (dragging: boolean, overCard: boolean) => void;
}

/** A building's placement ghost: its footprint, and whether it may be placed there. */
export interface Ghost { "tileX": number; "tileY": number; "fw": number; "fh": number; "valid": boolean }

export interface RendererState {
	"scene": Phaser.Scene;
	"map": GameMap;
	"callbacks": RendererCallbacks;
	/** World-space graphics (scroll with the camera), and screen-space (fixed: the drag box, the minimap). */
	"gfx": Phaser.GameObjects.Graphics;
	"uiGfx": Phaser.GameObjects.Graphics;
	"cursors": Phaser.Types.Input.Keyboard.CursorKeys;
	"chunks": ChunkRenderer;
	"minimap": Minimap;
	"tileset": string;
	"team": number | undefined;
	/** Per-tile fog (fog.ts), recomputed when the view changes. */
	"fog": Uint8Array;
	/** What's drawn: own units as predicted, everyone else as the view has them. */
	"units": UnitInfo[];
	"view": InstanceView | undefined;
	"selected": Set<number>;
	"pendingSheets": Set<string>;
	"unitSprites": Map<number, Phaser.GameObjects.Sprite>;
	"buildingSprites": Map<number, Phaser.GameObjects.Sprite>;
	/** Interpolation: each unit's position in the previous view, and where its sprite is drawn now (world px). */
	"prevPos": Map<number, { "x": number; "y": number }>;
	"dispPos": Map<number, { "x": number; "y": number }>;
	"snapAt": number;
	"snapInterval": number;
	"centered": boolean;
	"drag": { "sx": number; "sy": number; "ex": number; "ey": number } | undefined;
	"minimapDragging": boolean;
	"ghost": Ghost | null;
}

function mapPixels(map: GameMap): [number, number] {
	return [map.info.mapW * TILE_PX, map.info.mapH * TILE_PX];
}

/** Own units under a drag box, or the nearest under a click — hit-tested where they're drawn. */
function pick(renderer: RendererState, x0: number, y0: number, x1: number, y1: number): number[] {
	const own = renderer.units.filter((unit) => unit.team === renderer.team);
	const drawnAt = (unit: UnitInfo) => renderer.dispPos.get(unit.uid) ?? { "x": unit.x / FP, "y": unit.y / FP };
	const halfBox = (unit: UnitInfo): [number, number] => (unit.building === undefined ? unitBoxHalfPx(unitTypeId(unit.type)) : [unit.building.w * TILE_PX / 2, unit.building.h * TILE_PX / 2]);

	if (Math.abs(x1 - x0) < 4 && Math.abs(y1 - y0) < 4) {
		const hit = own.map((unit) => ({ "unit": unit, "at": drawnAt(unit), "half": halfBox(unit) }))
			.filter(({ at, half }) => Math.abs(at.x - x1) <= half[0] && Math.abs(at.y - y1) <= half[1])
			.sort((left, right) => Math.hypot(left.at.x - x1, left.at.y - y1) - Math.hypot(right.at.x - x1, right.at.y - y1));

		return hit.length === 0 ? [] : [hit[0].unit.uid];
	}

	const [left, right, top, bottom] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];

	// A box selects mobile units (buildings are picked by clicking them), as WC2 does.
	return own.filter((unit) => unit.building === undefined).filter((unit) => {
		const at = drawnAt(unit);

		return at.x >= left && at.x <= right && at.y >= top && at.y <= bottom;
	}).map((unit) => unit.uid);
}

function create(renderer: RendererState): void {
	const { scene, map } = renderer;
	const [pixelW, pixelH] = mapPixels(map);

	renderer.chunks = new ChunkRenderer(scene, map.render.gids, map.info.mapW, map.info.mapH, renderer.tileset);
	renderer.minimap = new Minimap(scene, MINIMAP_SIZE, MINIMAP_SIZE);
	renderer.minimap.rebuild(map.render.gids, map.info.mapW, map.info.mapH, renderer.tileset, map.render.spacing, map.render.margin);
	scene.cameras.main.setBounds(0, 0, Math.max(pixelW, scene.scale.width), Math.max(pixelH, scene.scale.height));
	renderer.gfx = scene.add.graphics().setDepth(2);
	renderer.uiGfx = scene.add.graphics().setScrollFactor(0).setDepth(10);
	renderer.cursors = scene.input.keyboard!.createCursorKeys();
	scene.input.mouse?.disableContextMenu();
	scene.input.keyboard!.on("keydown-ESC", () => { renderer.callbacks.onEscape?.(); });
	// Letter keys are command-card hotkeys (so WASD doesn't pan: the arrows do, as in WC2).
	scene.input.keyboard!.on("keydown", (event: KeyboardEvent) => {
		if (event.key.length === 1 && /[a-z]/iu.test(event.key)) {
			renderer.callbacks.onHotkey?.(event.key);
		}
	});

	scene.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
		if (!pointer.leftButtonDown()) {
			return;
		}

		if (renderer.minimap.contains(pointer.x, pointer.y)) {
			renderer.minimapDragging = true;
			renderer.minimap.panCameraTo(pointer.x, pointer.y, pixelW, pixelH);
		} else {
			renderer.drag = { "sx": pointer.x, "sy": pointer.y, "ex": pointer.x, "ey": pointer.y };
			renderer.callbacks.onDrag?.(true, false);
		}
	});
	scene.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
		if (renderer.minimapDragging) {
			renderer.minimap.panCameraTo(pointer.x, pointer.y, pixelW, pixelH);
		} else if (renderer.drag !== undefined) {
			renderer.drag.ex = pointer.x;
			renderer.drag.ey = pointer.y;
			renderer.callbacks.onDrag?.(true, Math.max(renderer.drag.sx, pointer.x) >= scene.scale.width - UI_RIGHT && Math.max(renderer.drag.sy, pointer.y) >= scene.scale.height - UI_BOTTOM);
		}

		if (!renderer.minimap.contains(pointer.x, pointer.y)) {
			const at = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);

			renderer.callbacks.onHover?.(Math.round(at.x * FP), Math.round(at.y * FP));
		}
	});
	scene.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
		if (renderer.minimapDragging) {
			renderer.minimapDragging = false;
		} else if (renderer.drag !== undefined) {
			const { sx, sy, ex, ey } = renderer.drag;
			const camera = scene.cameras.main;
			const from = camera.getWorldPoint(sx, sy);
			const to = camera.getWorldPoint(ex, ey);

			renderer.drag = undefined;
			renderer.callbacks.onDrag?.(false, false);

			// An armed ability or a placement takes the click as its target, and the selection stays.
			if (renderer.callbacks.onPrimaryClick?.(Math.round(to.x * FP), Math.round(to.y * FP)) !== true) {
				renderer.selected = new Set(pick(renderer, from.x, from.y, to.x, to.y));
				renderer.callbacks.onSelect([...renderer.selected]);
			}
		}

		if (pointer.rightButtonReleased() && !renderer.minimap.contains(pointer.x, pointer.y)) {
			const at = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);

			renderer.callbacks.onSecondaryClick(Math.round(at.x * FP), Math.round(at.y * FP), (pointer.event as MouseEvent | undefined)?.shiftKey ?? false);
		}
	});
}

function update(renderer: RendererState, delta: number): void {
	const { scene, map } = renderer;
	const camera = scene.cameras.main;
	const [pixelW, pixelH] = mapPixels(map);

	if (renderer.cursors.left.isDown) { camera.scrollX -= CAM_SPEED; }
	if (renderer.cursors.right.isDown) { camera.scrollX += CAM_SPEED; }
	if (renderer.cursors.up.isDown) { camera.scrollY -= CAM_SPEED; }
	if (renderer.cursors.down.isDown) { camera.scrollY += CAM_SPEED; }

	renderer.chunks.update(camera);
	renderer.chunks.updateFog(renderer.fog, map.info.mapW, map.info.mapH);
	renderer.gfx.clear();
	renderer.uiGfx.clear();
	renderer.minimap.reposition();
	renderer.minimap.draw(renderer.uiGfx, renderer.units, pixelW, pixelH, renderer.team ?? -1, (tx, ty) => renderer.fog[ty * map.info.mapW + tx] === VISIBLE);
	drawEntities(renderer, renderer.units, delta);

	if (renderer.ghost !== null) {
		const { tileX, tileY, fw, fh, valid } = renderer.ghost;
		const color = valid ? 0x33FF33 : 0xFF3333;

		renderer.gfx.fillStyle(color, 0.28);
		renderer.gfx.fillRect(tileX * TILE_PX, tileY * TILE_PX, fw * TILE_PX, fh * TILE_PX);
		renderer.gfx.lineStyle(1.5, color, 0.9);
		renderer.gfx.strokeRect(tileX * TILE_PX, tileY * TILE_PX, fw * TILE_PX, fh * TILE_PX);
	}

	if (renderer.drag !== undefined) {
		const { sx, sy, ex, ey } = renderer.drag;

		renderer.uiGfx.lineStyle(1, 0x88FF88, 0.8);
		renderer.uiGfx.strokeRect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy));
	}
}

/** Take the latest view: what to draw (own units as predicted, the rest as the view has them), the fog, and the
 *  interpolation baseline (where each unit was in the previous view). */
export function setView(renderer: RendererState, view: InstanceView): void {
	const own = view.predicted;
	const units = [...own, ...view.units.filter((unit) => unit.team !== view.team)];
	const now = performance.now();

	renderer.prevPos = new Map(renderer.units.map((unit) => [unit.uid, { "x": unit.x, "y": unit.y }]));
	renderer.units = units;
	renderer.view = view;
	renderer.team = view.team;
	computeFog(renderer.fog, renderer.map.info.mapW, renderer.map.info.mapH, view.explored, own);

	// Track the real gap between views (smoothed), so interpolation matches the tick cadence whatever the speed.
	if (renderer.snapAt > 0) {
		const gap = now - renderer.snapAt;

		if (gap > 0 && gap < 1000) { renderer.snapInterval = renderer.snapInterval * 0.8 + gap * 0.2; }
	}

	renderer.snapAt = now;

	// Start looking at our own units.
	if (!renderer.centered && own.length > 0) {
		renderer.centered = true;
		renderer.scene.cameras.main.centerOn(own.reduce((sum, unit) => sum + unit.x, 0) / own.length / FP, own.reduce((sum, unit) => sum + unit.y, 0) / own.length / FP);
	}

	// Units that are gone (died, out of sight) leave the selection.
	const present = new Set(own.map((unit) => unit.uid));

	if ([...renderer.selected].some((uid) => !present.has(uid))) {
		renderer.selected = new Set([...renderer.selected].filter((uid) => present.has(uid)));
		renderer.callbacks.onSelect([...renderer.selected]);
	}
}

/** Show (or clear, with null) the placement ghost. */
export function setGhost(renderer: RendererState, ghost: Ghost | null): void {
	renderer.ghost = ghost;
}

/** The crosshair while an ability waits for its target. */
export function setTargetingCursor(renderer: RendererState, on: boolean): void {
	renderer.scene.input.setDefaultCursor(on ? "crosshair" : "default");
}

/** Replace the selection (the page's: a building just placed, units just trained…). */
export function setSelection(renderer: RendererState, uids: number[]): void {
	renderer.selected = new Set(uids);
	renderer.callbacks.onSelect([...renderer.selected]);
}

/** Centre the camera on a world point (FP). */
export function lookAt(renderer: RendererState, xFP: number, yFP: number): void {
	renderer.centered = true;
	renderer.scene.cameras.main.centerOn(xFP / FP, yFP / FP);
}

/** Where a world point (FP) is on the canvas, in CSS pixels — for scripts and tests. */
export function worldToScreen(renderer: RendererState, xFP: number, yFP: number): { "x": number; "y": number } {
	const camera = renderer.scene.cameras.main;

	return { "x": (xFP / FP - camera.scrollX) * camera.zoom, "y": (yFP / FP - camera.scrollY) * camera.zoom };
}

/** Start the renderer in `parent` on `map`; resolves once its scene is up and drawing. */
export async function startRenderer(parent: HTMLElement, map: GameMap, callbacks: RendererCallbacks): Promise<RendererState> {
	return new Promise((resolve) => {
		const game = new Phaser.Game({
			"type": Phaser.AUTO,
			"parent": parent,
			"backgroundColor": "#05070a",
			"pixelArt": true,
			"scale": { "mode": Phaser.Scale.RESIZE, "width": parent.clientWidth || window.innerWidth, "height": parent.clientHeight || window.innerHeight },
			"loader": { "crossOrigin": "anonymous" },
			"banner": false
		});
		const renderer = {
			"map": map,
			"callbacks": callbacks,
			"tileset": map.render.tileset,
			"team": undefined,
			"fog": new Uint8Array(map.info.mapW * map.info.mapH),
			"units": [],
			"view": undefined,
			"selected": new Set(),
			"pendingSheets": new Set(),
			"unitSprites": new Map(),
			"buildingSprites": new Map(),
			"prevPos": new Map(),
			"dispPos": new Map(),
			"snapAt": 0,
			"snapInterval": TICK_MS,
			"centered": false,
			"drag": undefined,
			"minimapDragging": false,
			"ghost": null
		} as RendererState;

		game.scene.add("war2", {
			"preload": function(this: Phaser.Scene) {
				renderer.scene = this;
				this.load.spritesheet(map.render.tileset, map.render.tilesetUrl, { "frameWidth": TILE_PX, "frameHeight": TILE_PX, "spacing": map.render.spacing, "margin": map.render.margin });
			},
			"create": function() {
				create(renderer);
				resolve(renderer);
			},
			"update": function(_time: number, delta: number) { update(renderer, delta); }
		}, true);
	});
}
