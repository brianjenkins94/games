/**
 * Phaser renderer — reads sim state, draws it, emits input events.
 * No game logic here; no sim dependencies except reading component arrays.
 *
 * Functional scene wired via util/phaser/scene.ts's createScene (consistent with games/dozer).  All
 * renderer state lives in a per-scene `RendererState` object (NOT on the Phaser.Scene type) — created in
 * init(), looked up by the lifecycle hooks through a module-level WeakMap, and threaded to the cohesive
 * sub-systems:
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

/**
 * Per-scene renderer state — the closure-captured equivalent of the old GameScene class fields.
 * Lives off the Phaser.Scene (held in a WeakMap), so it never pollutes the global Scene type.  `scene`
 * is the only link back to Phaser; everything else is private renderer state.  Sub-modules
 * (fog/hud/units) receive this and read `renderer.scene.*` for Phaser APIs, `renderer.*` for state.
 */
export interface RendererState {
    scene: Phaser.Scene;
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
    mapConfig: { tilesetUrl: string; mapJson: any } | null;   // from startPhaser via init(data)
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

/** The handle main.ts holds (alias for the state — it reaches Phaser via `renderer.scene`). */
export type Renderer = RendererState;

// Per-scene renderer lookup: the createScene lifecycle hooks get only the scene, so this maps each
// scene to its RendererState.  A WeakMap means zero footprint on the Phaser.Scene type.
const STATES = new WeakMap<Phaser.Scene, RendererState>();

/** Build the initial renderer state.  Fields set later in create()/wireHud (gfx, uiGfx, cursors,
 *  minimap, HUD refs) are intentionally omitted here — the `as RendererState` mirrors the old class's
 *  definite-assignment (`field!`). */
function createState(scene: Phaser.Scene): RendererState {
    return {
        scene,
        frameMs: 0,
        interactiveCells: [],
        tweakOpen: false,
        mapConfig: null,
        chunkRenderer: null,
        mapPixelW: 0,
        mapPixelH: 0,
        myTeam: 0,
        tileVis: null,
        tileExplored: null,
        mapTileW: 0,
        mapTileH: 0,
        unitSprites: new Map(),
        buildingSprites: new Map(),
        tilesetName: "summer",
        renderState: null,
        selectedUids: new Set(),
        prevPos: new Map(),
        dispPos: new Map(),
        snapAt: 0,
        snapInterval: TICK_MS,
        prediction: new Map(),
        onSelect: null,
        onPrimaryClick: null,
        onSecondaryClick: null,
        onSlot: null,
        onEscape: null,
        onHotkey: null,
        onHover: null,
        ghost: null,
        drag: false,
        sx: 0, sy: 0, ex: 0, ey: 0,
        mmDragging: false,
    } as RendererState;
}

// ── Lifecycle hooks (the GameModule passed to createScene) ────────────────────
// Each gets only the scene; they look up the RendererState and delegate to the impls below.

function init(scene: Phaser.Scene, data?: { tilesetUrl: string; mapJson: any }): void {
    const renderer = createState(scene);
    renderer.mapConfig = data?.mapJson ? data : null;
    STATES.set(scene, renderer);
}

function preload(scene: Phaser.Scene): void {
    const renderer = STATES.get(scene)!;
    // Scenario terrain sheet (forest plain grass), always available regardless of the boot map.
    scene.load.spritesheet(SCENARIO_TILESET, forestTilesetUrl, { frameWidth: TILE_PX, frameHeight: TILE_PX, spacing: 1, margin: 0 });
    if (!renderer.mapConfig) return;
    const { tilesetUrl, mapJson } = renderer.mapConfig;
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
    renderer.tilesetName = ts.name;
    for (const s of allSheets(ts.name)) {
        scene.load.spritesheet(s.key, s.url, { frameWidth: s.frameW, frameHeight: s.frameH });
    }
}

function create(scene: Phaser.Scene): void {
    const renderer = STATES.get(scene)!;
    renderer.minimap = new Minimap(scene, MINIMAP_SZ, UI.bottom);

    // ── Terrain chunk renderer ────────────────────────────────────────────
    if (renderer.mapConfig) {
        const { mapJson } = renderer.mapConfig;
        const ts = mapJson.tilesets[0];
        renderer.chunkRenderer = new ChunkRenderer(
            scene,
            mapJson.layers.find((l: any) => l.type === "tilelayer").data,
            mapJson.width,
            mapJson.height,
            ts.name,
        );
        renderer.mapPixelW = mapJson.width  * mapJson.tilewidth;
        renderer.mapPixelH = mapJson.height * mapJson.tileheight;
        // The HUD is a translucent overlay, so the world renders edge-to-edge:
        // scroll bounds are simply the map size.
        scene.cameras.main.setBounds(0, 0, renderer.mapPixelW, renderer.mapPixelH);

        renderer.mapTileW    = renderer.mapPixelW / TILE_PX;
        renderer.mapTileH    = renderer.mapPixelH / TILE_PX;
        renderer.tileVis     = new Uint8Array(renderer.mapTileW * renderer.mapTileH);
        renderer.tileExplored = new Uint8Array(renderer.mapTileW * renderer.mapTileH);

        renderer.minimap.rebuild(
            mapJson.layers.find((l: any) => l.type === "tilelayer").data,
            mapJson.width, mapJson.height, ts.name, ts.spacing ?? 0, ts.margin ?? 0,
        );
    }

    // ── Graphics layers ───────────────────────────────────────────────────
    // depth: terrain=-1, units(sprites)=0, overlays(gfx)=2, ui(uiGfx)=10
    renderer.gfx   = scene.add.graphics().setDepth(2);
    renderer.uiGfx = scene.add.graphics().setScrollFactor(0).setDepth(10);

    // ── Keyboard ──────────────────────────────────────────────────────────
    // Arrow keys pan (WC2/StarCraft style); letter keys are command-card
    // hotkeys, so WASD is intentionally NOT bound to panning.
    renderer.cursors = scene.input.keyboard!.createCursorKeys();

    scene.input.keyboard!.on("keydown-ESC", () => renderer.onEscape?.());

    // Letter keys → command-card hotkeys (A–Z only; let everything else,
    // e.g. the console's backtick, pass through untouched).
    scene.input.keyboard!.on("keydown", (ev: KeyboardEvent) => {
        if (ev.key.length === 1 && /[a-zA-Z]/.test(ev.key)) renderer.onHotkey?.(ev.key);
    });

    // ── Pointer events ────────────────────────────────────────────────────
    scene.input.mouse?.disableContextMenu();

    scene.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
        if (p.leftButtonDown()) {
            if (renderer.minimap.contains(p.x, p.y)) {
                renderer.mmDragging = true;
                renderer.minimap.panCameraTo(p.x, p.y, renderer.mapPixelW, renderer.mapPixelH);
            } else {
                renderer.drag = true;
                renderer.sx = p.x; renderer.sy = p.y;
                renderer.ex = p.x; renderer.ey = p.y;
                // Let the drag track across the perimeter cells (see hud.setHudDragMode).
                setHudDragMode(renderer, true);
            }
        }
    });

    scene.input.on("pointermove", (p: Phaser.Input.Pointer) => {
        if (renderer.mmDragging) {
            renderer.minimap.panCameraTo(p.x, p.y, renderer.mapPixelW, renderer.mapPixelH);
        } else if (renderer.drag) {
            renderer.ex = p.x; renderer.ey = p.y;
        }
        // Drive the placement ghost (game area only — not over the minimap).
        // Perimeter HUD cells capture their own pointer events, so the only
        // non-game region that reaches the canvas is the minimap.
        if (renderer.onHover && !renderer.minimap.contains(p.x, p.y)) {
            const w = scene.cameras.main.getWorldPoint(p.x, p.y);
            renderer.onHover(w.x * FP, w.y * FP);
        }
    });

    scene.input.on("pointerup", (p: Phaser.Input.Pointer) => {
        if (renderer.mmDragging) {
            renderer.mmDragging = false;
        } else if (renderer.drag) {
            renderer.drag = false;
            setHudDragMode(renderer, false);
            finishSelect(renderer);
        }
        // Right-clicks only fire in the game area, not over the minimap.
        if (p.rightButtonReleased() && !renderer.minimap.contains(p.x, p.y)) {
            const w = scene.cameras.main.getWorldPoint(p.x, p.y);
            renderer.onSecondaryClick?.(w.x * FP, w.y * FP);
        }
    });

    // ── DOM HUD ───────────────────────────────────────────────────────────
    wireHud(renderer);
}

function update(scene: Phaser.Scene, _time: number, delta: number): void {
    const renderer = STATES.get(scene)!;
    // Rolling render frame time (ms) for the perf overlay — EMA to smooth jitter.
    renderer.frameMs += (delta - renderer.frameMs) * 0.1;

    // ── Terrain chunks ────────────────────────────────────────────────────
    renderer.chunkRenderer?.update(scene.cameras.main);

    // ── Camera scroll ─────────────────────────────────────────────────────
    const cam = scene.cameras.main;
    if (renderer.cursors.left.isDown)  cam.scrollX -= CAM_SPEED;
    if (renderer.cursors.right.isDown) cam.scrollX += CAM_SPEED;
    if (renderer.cursors.up.isDown)    cam.scrollY -= CAM_SPEED;
    if (renderer.cursors.down.isDown)  cam.scrollY += CAM_SPEED;

    if (!renderer.renderState) return;
    const units = renderer.renderState.units;
    updateFow(renderer, units);
    renderer.gfx.clear();
    renderer.uiGfx.clear();

    // The translucent DOM grid provides the HUD backgrounds; the canvas only
    // draws the minimap contents + the drag rect on top of the world.
    const sw = scene.scale.width;
    const sh = scene.scale.height;
    // Keep the minimap terrain backdrop pinned to the bottom-left on resize.
    renderer.minimap.reposition();
    renderer.minimap.draw(
        renderer.uiGfx, units, renderer.mapPixelW, renderer.mapPixelH, renderer.myTeam,
        (tx, ty) => !!renderer.tileVis && renderer.tileVis[ty * renderer.mapTileW + tx] >= 2,
    );

    // ── Units + buildings (world space) ───────────────────────────────────
    drawEntities(renderer, units, delta);

    // ── Building-placement ghost (world space) ────────────────────────────
    if (renderer.ghost) {
        const { tileX, tileY, fw, fh, valid } = renderer.ghost;
        const color = valid ? 0x33ff33 : 0xff3333;
        const x = tileX * TILE_PX, y = tileY * TILE_PX, w = fw * TILE_PX, h = fh * TILE_PX;
        renderer.gfx.fillStyle(color, 0.28);
        renderer.gfx.fillRect(x, y, w, h);
        renderer.gfx.lineStyle(1.5, color, 0.9);
        renderer.gfx.strokeRect(x, y, w, h);
    }

    // ── Drag-select rect (screen space) ───────────────────────────────────
    if (renderer.drag) {
        renderer.uiGfx.lineStyle(1, 0x88ff88, 0.8);
        renderer.uiGfx.strokeRect(
            Math.min(renderer.sx, renderer.ex), Math.min(renderer.sy, renderer.ey),
            Math.abs(renderer.ex - renderer.sx), Math.abs(renderer.ey - renderer.sy),
        );
        // Fade the command card when the drag sweeps into its cell so the
        // selection box / units underneath stay visible.
        const dr = Math.max(renderer.sx, renderer.ex), db = Math.max(renderer.sy, renderer.ey);
        const overCard = dr >= sw - UI.right && db >= sh - UI.bottom;
        renderer.cardEl.style.opacity = overCard ? "0.2" : "1";
    }
}

/** Debug/e2e: tear down the boot terrain and rebuild it for a loaded scenario — a fresh
 *  ChunkRenderer at the scenario's dimensions, fully lit (scenarios run without fog). `gids` are
 *  real tileset frame ids (grass for walkable, wall for blocked), built by the worker. The camera
 *  is re-bounded and zoomed to fit the (usually tiny) scenario so you can watch it. */
export function rebuildMap(renderer: Renderer, gids: number[], mapW: number, mapH: number): void {
    if (!renderer.tilesetName) return;
    const scene = renderer.scene;

    // Blank slate: drop the old map's unit sprites + interpolation baselines so the new scenario's
    // units appear at their tiles instead of tweening in from their previous (old-map) positions.
    for (const s of renderer.unitSprites.values()) s.destroy();
    renderer.unitSprites.clear();
    for (const s of renderer.buildingSprites.values()) s.destroy();
    renderer.buildingSprites.clear();
    renderer.renderState = null;
    renderer.prevPos.clear();
    renderer.dispPos.clear();

    renderer.chunkRenderer?.destroy();
    renderer.chunkRenderer = new ChunkRenderer(scene, gids, mapW, mapH, SCENARIO_TILESET);
    renderer.minimap.rebuild(gids, mapW, mapH, SCENARIO_TILESET, 1, 0);   // regen minimap for the new map

    renderer.mapTileW  = mapW;
    renderer.mapTileH  = mapH;
    renderer.mapPixelW = mapW * TILE_PX;
    renderer.mapPixelH = mapH * TILE_PX;
    renderer.tileVis      = new Uint8Array(mapW * mapH).fill(2);   // VISIBLE everywhere (no fog)
    renderer.tileExplored = new Uint8Array(mapW * mapH).fill(1);

    const cam = scene.cameras.main;
    // No bounds: a scenario map is smaller than the viewport, and bounds would clamp the scroll to
    // the top-left and defeat centring. Centre the (native-scale) map in the window instead.
    cam.removeBounds();
    cam.setZoom(1);   // native 1:1 (reset any prior scenario's fit-zoom)
    cam.centerOn(renderer.mapPixelW / 2, renderer.mapPixelH / 2);

    renderer.chunkRenderer.update(cam);
    renderer.chunkRenderer.updateFog(renderer.tileVis, mapW, mapH);
}

/** Push the latest worker snapshot.  Rolls the current positions into the
 *  interpolation baseline so update() can lerp toward the new snapshot. */
export function setRenderState(renderer: Renderer, state: RenderState): void {
    if (renderer.renderState) {
        renderer.prevPos.clear();
        for (const u of renderer.renderState.units) renderer.prevPos.set(u.uid, { x: u.x, y: u.y });
    }
    renderer.renderState = state;
    const now = performance.now();
    // Track the real gap between snapshots (EMA-smoothed, sanity-clamped) so interpolation
    // matches the current tick cadence — game speed changes it; a stalled tab inflates it.
    if (renderer.snapAt > 0) {
        const dt = now - renderer.snapAt;
        if (dt > 0 && dt < 1000) renderer.snapInterval = renderer.snapInterval * 0.8 + dt * 0.2;
    }
    renderer.snapAt = now;
}

/** Share the live prediction map (main.ts mutates it; we read it each frame). */
export function setPrediction(renderer: Renderer, prediction: Map<number, UnitPrediction>): void {
    renderer.prediction = prediction;
}

/** Update the locally-owned selection (stable unit-ids) for selection rings. */
export function setSelectedUids(renderer: Renderer, uids: Set<number>): void {
    renderer.selectedUids = uids;
}

/** Toggle the targeting (crosshair) cursor for armed abilities. */
export function setTargetingCursor(renderer: Renderer, on: boolean): void {
    renderer.scene.input.setDefaultCursor(on ? "crosshair" : "default");
}

/** Set (or clear, with null) the building-placement ghost. Drawn in update(). */
export function showPlacementGhost(renderer: Renderer, ghost: { tileX: number; tileY: number; fw: number; fh: number; valid: boolean } | null): void {
    renderer.ghost = ghost;
}

/** Resolve a drag-select (or single click) into a selection, honouring an armed ability's
 *  target-consuming primary click.  Emits onSelect with the hit unit-ids. */
function finishSelect(renderer: Renderer): void {
    if (!renderer.onSelect) return;

    // An armed ability consumes the click as its target — no selection change.
    const cam  = renderer.scene.cameras.main;
    if (renderer.onPrimaryClick) {
        const cp = cam.getWorldPoint(renderer.ex, renderer.ey);
        if (renderer.onPrimaryClick(cp.x * FP, cp.y * FP)) return;
    }

    // Convert screen-space drag corners to world space
    const tl   = cam.getWorldPoint(Math.min(renderer.sx, renderer.ex), Math.min(renderer.sy, renderer.ey));
    const br   = cam.getWorldPoint(Math.max(renderer.sx, renderer.ex), Math.max(renderer.sy, renderer.ey));
    const x0 = tl.x * FP, y0 = tl.y * FP;
    const x1 = br.x * FP, y1 = br.y * FP;

    const hits: number[] = [];
    for (const u of renderer.renderState?.units ?? []) {
        if (u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1) hits.push(u.uid);
    }

    // Single click with no drag → deselect all
    if (Math.abs(renderer.ex - renderer.sx) < 4 && Math.abs(renderer.ey - renderer.sy) < 4 && hits.length === 0) {
        renderer.onSelect([]);
    } else {
        renderer.onSelect(hits);
    }
}

export function startPhaser(
    parent:    HTMLElement,
    mapConfig: { tilesetUrl: string; mapJson: any },
): Promise<Renderer> {
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
            scene.events.once("create", () => resolve(STATES.get(scene)!));
        });
    });
}
