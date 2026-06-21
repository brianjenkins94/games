/**
 * Phaser renderer — reads sim state, draws it, emits input events.
 * No game logic here; no sim dependencies except reading component arrays.
 *
 * Functional scene: rather than subclass Phaser.Scene, the renderer is a module of free functions
 * (init/preload/create/update + the input/selection glue) that operate on the passed scene, wired up
 * via util/phaser/scene.ts's createScene (consistent with games/dozer).  The scene's state lives on the
 * scene object itself — typed by the `declare module "phaser"` augmentation below.
 *
 * This file is the coordinator; the cohesive sub-systems live alongside it:
 *   • fog.ts   — per-tile visibility (updateFow)
 *   • hud.ts   — the DOM HUD overlay + command card
 *   • units.ts — the per-frame entity draw loop (drawEntities)
 *   • Minimap.ts — the bottom-left minimap
 *
 * Coordinate spaces:
 *   screen  — pixel offset from the canvas top-left corner (pointer events)
 *   world   — pixel offset from the map top-left corner (where units live)
 *   FP      — world * FP (integer fixed-point used by the sim)
 */
import Phaser from "phaser";
import { FP, TICK_MS } from "../game/components";
import type { RenderState } from "../worker/ipc";

/** Local-prediction overlay for an own unit: instant facing + move marker shown
 *  the moment a command is issued, until the authoritative snapshot catches up. */
export interface UnitPrediction { dir: number; mtx: number; mty: number; at: number; }
import { ChunkRenderer, TILE_PX } from "./ChunkRenderer";
import { Minimap } from "./Minimap";
import { createScene } from "../../../../util/phaser/scene";
import { updateFow } from "./fog";
import { wireHud, setHudDragMode } from "./hud";
import { drawEntities } from "./units";
// Data-driven sprite registry — the spritesheets to load for the active tileset.
import { allSheets } from "./sprites";
// Debug/e2e scenarios render terrain from the forest tileset (clean plain grass), independent of the
// boot map's tileset. Loaded in preload(); see rebuildMap().
import forestTilesetUrl from "../assets/tilesets/forest.png";
const SCENARIO_TILESET = "forest";

// The HUD is a translucent holy-grail overlay declared in client.html (markup +
// CSS); hud.ts wires the dynamic bits.  UI gives the chrome thickness of each edge
// in px and must match the --ui-* CSS variables in client.html.
const UI = { top: 32, right: 150, bottom: 120, left: 120 };
const MINIMAP_SZ = UI.left;   // minimap is a square filling the bottom-left cell
const CAM_SPEED  = 8;         // camera pan, pixels per frame

/** Drag-select result — stable unit-ids of the units under the selection box. */
export type SelectCallback = (uids: number[]) => void;

/** Convenience alias for the renderer's scene (a plain Phaser.Scene carrying the fields below). */
export type GameScene = Phaser.Scene;

// The renderer hangs all its state on the scene (the functional-scene equivalent of class fields).
// Shared across renderer.ts and its sub-modules (fog/hud/units/Minimap), which read these fields.
declare module "phaser" {
    interface Scene {
        // World-space graphics (scrolls with camera) + screen-space graphics (fixed: drag rect, minimap).
        gfx:   Phaser.GameObjects.Graphics;
        uiGfx: Phaser.GameObjects.Graphics;
        /** Rolling render frame time (ms), EMA-smoothed in update(); read by the client shell for perf. */
        frameMs: number;
        // Refs into the static HUD markup (client.html), grabbed in wireHud().
        resourceCell: HTMLDivElement;   // top-centre: gold / lumber / oil / food
        portraitCell: HTMLDivElement;   // bottom-centre: selected-unit portrait + stats
        interactiveCells: HTMLDivElement[];   // chrome panels flipped click-through during a drag
        // Collapsible right-edge tweak panel.
        tweakPaneEl: HTMLDivElement;
        tweakBodyEl: HTMLDivElement;
        tweakOpen: boolean;
        cardEl: HTMLDivElement;   // command-card DOM grid (view only)
        cursors: Phaser.Types.Input.Keyboard.CursorKeys;
        // Received from startPhaser() via Phaser's init(data) mechanism.
        mapConfig: { tilesetUrl: string; mapJson: any } | null;
        chunkRenderer: ChunkRenderer | null;
        mapPixelW: number;   // map dimensions in world pixels
        mapPixelH: number;
        minimap: Minimap;   // bottom-left minimap (owns its terrain backdrop)
        myTeam: number;   // fog of war — set by main.ts after scene boots
        // Per-tile visibility (0=UNEXPLORED, 1=EXPLORED, 2=VISIBLE). tileExplored persists.
        tileVis: Uint8Array | null;
        tileExplored: Uint8Array | null;
        mapTileW: number;
        mapTileH: number;
        // One Phaser Sprite per live unit / building — keyed by stable unit-id.
        unitSprites: Map<number, Phaser.GameObjects.Sprite>;
        buildingSprites: Map<number, Phaser.GameObjects.Sprite>;
        tilesetName: string;   // active map's tileset (picks building art)
        renderState: RenderState | null;   // latest per-tick worker snapshot
        selectedUids: Set<number>;   // locally-owned selection (main-thread UI state)
        // Interpolation baselines (uid → world FP / px) + snapshot timing.
        prevPos: Map<number, { x: number; y: number }>;
        dispPos: Map<number, { x: number; y: number }>;
        snapAt: number;
        snapInterval: number;
        prediction: Map<number, UnitPrediction>;   // own-unit facing/marker overlay (read each frame)
        // Raw input callbacks — main.ts routes these to the command-card controller.
        onSelect: SelectCallback | null;
        onPrimaryClick:   ((wxFP: number, wyFP: number) => boolean) | null;
        onSecondaryClick: ((wxFP: number, wyFP: number) => void) | null;
        onSlot:   ((index: number) => void) | null;
        onEscape: (() => void) | null;
        onHotkey: ((letter: string) => boolean) | null;
        onHover:  ((wxFP: number, wyFP: number) => void) | null;
        // Building-placement ghost (render-only) + drag-select state (screen coords).
        ghost: { tileX: number; tileY: number; fw: number; fh: number; valid: boolean } | null;
        drag: boolean;
        sx: number; sy: number; ex: number; ey: number;
        mmDragging: boolean;   // minimap drag-pan state
    }
}

/** Initialise all scene state (the functional-scene equivalent of class field initialisers).
 *  Runs first, before preload/create; `data` carries the map config from startPhaser. */
export function init(scene: Phaser.Scene, data?: { tilesetUrl: string; mapJson: any }): void {
    scene.frameMs          = 0;
    scene.interactiveCells = [];
    scene.tweakOpen        = false;
    scene.mapConfig        = data?.mapJson ? data : null;
    scene.chunkRenderer    = null;
    scene.mapPixelW        = 0;
    scene.mapPixelH        = 0;
    scene.myTeam           = 0;
    scene.tileVis          = null;
    scene.tileExplored     = null;
    scene.mapTileW         = 0;
    scene.mapTileH         = 0;
    scene.unitSprites      = new Map();
    scene.buildingSprites  = new Map();
    scene.tilesetName      = "summer";
    scene.renderState      = null;
    scene.selectedUids     = new Set();
    scene.prevPos          = new Map();
    scene.dispPos          = new Map();
    scene.snapAt           = 0;
    scene.snapInterval     = TICK_MS;
    scene.prediction       = new Map();
    scene.onSelect         = null;
    scene.onPrimaryClick   = null;
    scene.onSecondaryClick = null;
    scene.onSlot           = null;
    scene.onEscape         = null;
    scene.onHotkey         = null;
    scene.onHover          = null;
    scene.ghost            = null;
    scene.drag             = false;
    scene.sx = scene.sy = scene.ex = scene.ey = 0;
    scene.mmDragging       = false;
}

export function preload(scene: Phaser.Scene): void {
    // Scenario terrain sheet (forest plain grass), always available regardless of the boot map.
    scene.load.spritesheet(SCENARIO_TILESET, forestTilesetUrl, { frameWidth: TILE_PX, frameHeight: TILE_PX, spacing: 1, margin: 0 });
    if (!scene.mapConfig) return;
    const { tilesetUrl, mapJson } = scene.mapConfig;
    const ts = mapJson.tilesets[0];
    // Load as spritesheet so individual tile GIDs address frames directly.
    scene.load.spritesheet(ts.name, tilesetUrl, {
        frameWidth:  TILE_PX,
        frameHeight: TILE_PX,
        spacing:     ts.spacing ?? 0,
        margin:      ts.margin  ?? 0,
    });

    // All unit / building / construction spritesheets for this tileset, from
    // the data-driven sprite registry (one place, one convention).
    scene.tilesetName = ts.name;
    for (const s of allSheets(ts.name)) {
        scene.load.spritesheet(s.key, s.url, { frameWidth: s.frameW, frameHeight: s.frameH });
    }
}

export function create(scene: Phaser.Scene): void {
    scene.minimap = new Minimap(scene, MINIMAP_SZ, UI.bottom);

    // ── Terrain chunk renderer ────────────────────────────────────────────
    if (scene.mapConfig) {
        const { mapJson } = scene.mapConfig;
        const ts = mapJson.tilesets[0];
        scene.chunkRenderer = new ChunkRenderer(
            scene,
            mapJson.layers.find((l: any) => l.type === "tilelayer").data,
            mapJson.width,
            mapJson.height,
            ts.name,
        );
        scene.mapPixelW = mapJson.width  * mapJson.tilewidth;
        scene.mapPixelH = mapJson.height * mapJson.tileheight;
        // The HUD is a translucent overlay, so the world renders edge-to-edge:
        // scroll bounds are simply the map size.
        scene.cameras.main.setBounds(0, 0, scene.mapPixelW, scene.mapPixelH);

        scene.mapTileW    = scene.mapPixelW / TILE_PX;
        scene.mapTileH    = scene.mapPixelH / TILE_PX;
        scene.tileVis     = new Uint8Array(scene.mapTileW * scene.mapTileH);
        scene.tileExplored = new Uint8Array(scene.mapTileW * scene.mapTileH);

        scene.minimap.rebuild(
            mapJson.layers.find((l: any) => l.type === "tilelayer").data,
            mapJson.width, mapJson.height, ts.name, ts.spacing ?? 0, ts.margin ?? 0,
        );
    }

    // ── Graphics layers ───────────────────────────────────────────────────
    // depth: terrain=-1, units(sprites)=0, overlays(gfx)=2, ui(uiGfx)=10
    scene.gfx   = scene.add.graphics().setDepth(2);
    scene.uiGfx = scene.add.graphics().setScrollFactor(0).setDepth(10);

    // ── Keyboard ──────────────────────────────────────────────────────────
    // Arrow keys pan (WC2/StarCraft style); letter keys are command-card
    // hotkeys, so WASD is intentionally NOT bound to panning.
    scene.cursors = scene.input.keyboard!.createCursorKeys();

    scene.input.keyboard!.on("keydown-ESC", () => scene.onEscape?.());

    // Letter keys → command-card hotkeys (A–Z only; let everything else,
    // e.g. the console's backtick, pass through untouched).
    scene.input.keyboard!.on("keydown", (ev: KeyboardEvent) => {
        if (ev.key.length === 1 && /[a-zA-Z]/.test(ev.key)) scene.onHotkey?.(ev.key);
    });

    // ── Pointer events ────────────────────────────────────────────────────
    scene.input.mouse?.disableContextMenu();

    scene.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
        if (p.leftButtonDown()) {
            if (scene.minimap.contains(p.x, p.y)) {
                scene.mmDragging = true;
                scene.minimap.panCameraTo(p.x, p.y, scene.mapPixelW, scene.mapPixelH);
            } else {
                scene.drag = true;
                scene.sx = p.x; scene.sy = p.y;
                scene.ex = p.x; scene.ey = p.y;
                // Let the drag track across the perimeter cells (see hud.setHudDragMode).
                setHudDragMode(scene, true);
            }
        }
    });

    scene.input.on("pointermove", (p: Phaser.Input.Pointer) => {
        if (scene.mmDragging) {
            scene.minimap.panCameraTo(p.x, p.y, scene.mapPixelW, scene.mapPixelH);
        } else if (scene.drag) {
            scene.ex = p.x; scene.ey = p.y;
        }
        // Drive the placement ghost (game area only — not over the minimap).
        // Perimeter HUD cells capture their own pointer events, so the only
        // non-game region that reaches the canvas is the minimap.
        if (scene.onHover && !scene.minimap.contains(p.x, p.y)) {
            const w = scene.cameras.main.getWorldPoint(p.x, p.y);
            scene.onHover(w.x * FP, w.y * FP);
        }
    });

    scene.input.on("pointerup", (p: Phaser.Input.Pointer) => {
        if (scene.mmDragging) {
            scene.mmDragging = false;
        } else if (scene.drag) {
            scene.drag = false;
            setHudDragMode(scene, false);
            finishSelect(scene);
        }
        // Right-clicks only fire in the game area, not over the minimap.
        if (p.rightButtonReleased() && !scene.minimap.contains(p.x, p.y)) {
            const w = scene.cameras.main.getWorldPoint(p.x, p.y);
            scene.onSecondaryClick?.(w.x * FP, w.y * FP);
        }
    });

    // ── DOM HUD ───────────────────────────────────────────────────────────
    wireHud(scene);
}

export function update(scene: Phaser.Scene, _time: number, delta: number): void {
    // Rolling render frame time (ms) for the perf overlay — EMA to smooth jitter.
    scene.frameMs += (delta - scene.frameMs) * 0.1;

    // ── Terrain chunks ────────────────────────────────────────────────────
    scene.chunkRenderer?.update(scene.cameras.main);

    // ── Camera scroll ─────────────────────────────────────────────────────
    const cam = scene.cameras.main;
    if (scene.cursors.left.isDown)  cam.scrollX -= CAM_SPEED;
    if (scene.cursors.right.isDown) cam.scrollX += CAM_SPEED;
    if (scene.cursors.up.isDown)    cam.scrollY -= CAM_SPEED;
    if (scene.cursors.down.isDown)  cam.scrollY += CAM_SPEED;

    if (!scene.renderState) return;
    const units = scene.renderState.units;
    updateFow(scene, units);
    scene.gfx.clear();
    scene.uiGfx.clear();

    // The translucent DOM grid provides the HUD backgrounds; the canvas only
    // draws the minimap contents + the drag rect on top of the world.
    const sw = scene.scale.width;
    const sh = scene.scale.height;
    // Keep the minimap terrain backdrop pinned to the bottom-left on resize.
    scene.minimap.reposition();
    scene.minimap.draw(
        scene.uiGfx, units, scene.mapPixelW, scene.mapPixelH, scene.myTeam,
        (tx, ty) => !!scene.tileVis && scene.tileVis[ty * scene.mapTileW + tx] >= 2,
    );

    // ── Units + buildings (world space) ───────────────────────────────────
    drawEntities(scene, units, delta);

    // ── Building-placement ghost (world space) ────────────────────────────
    if (scene.ghost) {
        const { tileX, tileY, fw, fh, valid } = scene.ghost;
        const color = valid ? 0x33ff33 : 0xff3333;
        const x = tileX * TILE_PX, y = tileY * TILE_PX, w = fw * TILE_PX, h = fh * TILE_PX;
        scene.gfx.fillStyle(color, 0.28);
        scene.gfx.fillRect(x, y, w, h);
        scene.gfx.lineStyle(1.5, color, 0.9);
        scene.gfx.strokeRect(x, y, w, h);
    }

    // ── Drag-select rect (screen space) ───────────────────────────────────
    if (scene.drag) {
        scene.uiGfx.lineStyle(1, 0x88ff88, 0.8);
        scene.uiGfx.strokeRect(
            Math.min(scene.sx, scene.ex), Math.min(scene.sy, scene.ey),
            Math.abs(scene.ex - scene.sx), Math.abs(scene.ey - scene.sy),
        );
        // Fade the command card when the drag sweeps into its cell so the
        // selection box / units underneath stay visible.
        const dr = Math.max(scene.sx, scene.ex), db = Math.max(scene.sy, scene.ey);
        const overCard = dr >= sw - UI.right && db >= sh - UI.bottom;
        scene.cardEl.style.opacity = overCard ? "0.2" : "1";
    }
}

/** Debug/e2e: tear down the boot terrain and rebuild it for a loaded scenario — a fresh
 *  ChunkRenderer at the scenario's dimensions, fully lit (scenarios run without fog). `gids` are
 *  real tileset frame ids (grass for walkable, wall for blocked), built by the worker. The camera
 *  is re-bounded and zoomed to fit the (usually tiny) scenario so you can watch it. */
export function rebuildMap(scene: Phaser.Scene, gids: number[], mapW: number, mapH: number): void {
    if (!scene.tilesetName) return;

    // Blank slate: drop the old map's unit sprites + interpolation baselines so the new scenario's
    // units appear at their tiles instead of tweening in from their previous (old-map) positions.
    for (const s of scene.unitSprites.values()) s.destroy();
    scene.unitSprites.clear();
    for (const s of scene.buildingSprites.values()) s.destroy();
    scene.buildingSprites.clear();
    scene.renderState = null;
    scene.prevPos.clear();
    scene.dispPos.clear();

    scene.chunkRenderer?.destroy();
    scene.chunkRenderer = new ChunkRenderer(scene, gids, mapW, mapH, SCENARIO_TILESET);
    scene.minimap.rebuild(gids, mapW, mapH, SCENARIO_TILESET, 1, 0);   // regen minimap for the new map

    scene.mapTileW  = mapW;
    scene.mapTileH  = mapH;
    scene.mapPixelW = mapW * TILE_PX;
    scene.mapPixelH = mapH * TILE_PX;
    scene.tileVis      = new Uint8Array(mapW * mapH).fill(2);   // VISIBLE everywhere (no fog)
    scene.tileExplored = new Uint8Array(mapW * mapH).fill(1);

    const cam = scene.cameras.main;
    // No bounds: a scenario map is smaller than the viewport, and bounds would clamp the scroll to
    // the top-left and defeat centring. Centre the (native-scale) map in the window instead.
    cam.removeBounds();
    cam.setZoom(1);   // native 1:1 (reset any prior scenario's fit-zoom)
    cam.centerOn(scene.mapPixelW / 2, scene.mapPixelH / 2);

    scene.chunkRenderer.update(cam);
    scene.chunkRenderer.updateFog(scene.tileVis, mapW, mapH);
}

/** Push the latest worker snapshot.  Rolls the current positions into the
 *  interpolation baseline so update() can lerp toward the new snapshot. */
export function setRenderState(scene: Phaser.Scene, state: RenderState): void {
    if (scene.renderState) {
        scene.prevPos.clear();
        for (const u of scene.renderState.units) scene.prevPos.set(u.uid, { x: u.x, y: u.y });
    }
    scene.renderState = state;
    const now = performance.now();
    // Track the real gap between snapshots (EMA-smoothed, sanity-clamped) so interpolation
    // matches the current tick cadence — game speed changes it; a stalled tab inflates it.
    if (scene.snapAt > 0) {
        const dt = now - scene.snapAt;
        if (dt > 0 && dt < 1000) scene.snapInterval = scene.snapInterval * 0.8 + dt * 0.2;
    }
    scene.snapAt = now;
}

/** Share the live prediction map (main.ts mutates it; we read it each frame). */
export function setPrediction(scene: Phaser.Scene, prediction: Map<number, UnitPrediction>): void {
    scene.prediction = prediction;
}

/** Update the locally-owned selection (stable unit-ids) for selection rings. */
export function setSelectedUids(scene: Phaser.Scene, uids: Set<number>): void {
    scene.selectedUids = uids;
}

/** Toggle the targeting (crosshair) cursor for armed abilities. */
export function setTargetingCursor(scene: Phaser.Scene, on: boolean): void {
    scene.input.setDefaultCursor(on ? "crosshair" : "default");
}

/** Set (or clear, with null) the building-placement ghost. Drawn in update(). */
export function showPlacementGhost(scene: Phaser.Scene, ghost: { tileX: number; tileY: number; fw: number; fh: number; valid: boolean } | null): void {
    scene.ghost = ghost;
}

/** Resolve a drag-select (or single click) into a selection, honouring an armed ability's
 *  target-consuming primary click.  Emits onSelect with the hit unit-ids. */
function finishSelect(scene: Phaser.Scene): void {
    if (!scene.onSelect) return;

    // An armed ability consumes the click as its target — no selection change.
    const cam  = scene.cameras.main;
    if (scene.onPrimaryClick) {
        const cp = cam.getWorldPoint(scene.ex, scene.ey);
        if (scene.onPrimaryClick(cp.x * FP, cp.y * FP)) return;
    }

    // Convert screen-space drag corners to world space
    const tl   = cam.getWorldPoint(Math.min(scene.sx, scene.ex), Math.min(scene.sy, scene.ey));
    const br   = cam.getWorldPoint(Math.max(scene.sx, scene.ex), Math.max(scene.sy, scene.ey));
    const x0 = tl.x * FP, y0 = tl.y * FP;
    const x1 = br.x * FP, y1 = br.y * FP;

    const hits: number[] = [];
    for (const u of scene.renderState?.units ?? []) {
        if (u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1) hits.push(u.uid);
    }

    // Single click with no drag → deselect all
    if (Math.abs(scene.ex - scene.sx) < 4 && Math.abs(scene.ey - scene.sy) < 4 && hits.length === 0) {
        scene.onSelect([]);
    } else {
        scene.onSelect(hits);
    }
}

export function startPhaser(
    parent:    HTMLElement,
    mapConfig: { tilesetUrl: string; mapJson: any },
): Promise<GameScene> {
    return new Promise(resolve => {
        const game = new Phaser.Game({
            type:            Phaser.WEBGL,
            parent,
            backgroundColor: "#0d1117",
            pixelArt:        true,   // nearest-neighbour filtering + roundPixels
            scale: {
                mode:   Phaser.Scale.RESIZE,
                width:  parent.clientWidth  || window.innerWidth,
                height: parent.clientHeight || window.innerHeight,
            },
        });
        game.events.once("ready", () => {
            // Build the functional scene from this module's lifecycle hooks, then add it.
            // game.scene.add(key, sceneInstance, autoStart, initData) → Phaser calls init(initData).
            const scene = createScene({ name: "game", init, preload, create, update })();
            game.scene.add("game", scene, true, mapConfig);
            scene.events.once("create", () => resolve(scene));
        });
    });
}
