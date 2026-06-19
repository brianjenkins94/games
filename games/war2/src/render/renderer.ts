/**
 * Phaser renderer — reads sim state, draws it, emits input events.
 * No game logic here; no sim dependencies except reading component arrays.
 *
 * Viewport: canvas fills the window.  The camera scrolls over the full map.
 * A translucent 3×3 HUD grid (see UI) is overlaid on top: minimap bottom-left,
 * portrait bottom-centre, command card bottom-right, resource bar across the
 * top.  The centre cell is click-through; the world renders edge-to-edge behind
 * every cell.  Arrow keys pan the camera.
 *
 * Coordinate spaces:
 *   screen  — pixel offset from the canvas top-left corner (pointer events)
 *   world   — pixel offset from the map top-left corner (where units live)
 *   FP      — world * FP (integer fixed-point used by the sim)
 */
import Phaser from "phaser";
import { FP, TICK_MS } from "../game/components";
import { inRange } from "../game/distance";
import type { RenderState, RenderUnit } from "../worker/ipc";

/** Local-prediction overlay for an own unit: instant facing + move marker shown
 *  the moment a command is issued, until the authoritative snapshot catches up. */
export interface UnitPrediction { dir: number; mtx: number; mty: number; at: number; }
import { ChunkRenderer, TILE_PX } from "./ChunkRenderer";
// Command-card icon sheet.  Tileset-specific; the current map is winter, so we
// load the winter sheet.  TODO: follow the active map's tileset like tilesetUrl.
import iconsUrl   from "../assets/graphics/tilesets/winter/icons.png";
import iconsJson  from "../assets/icons.json";
import type { CommandCard } from "../game/abilities";
import { unitTypeName, unitBuildTicks, unitSight, unitBoxHalfPx } from "../game/unitTypes";
// Data-driven sprite registry — all unit/building/construction art resolution.
import { allSheets, sheetForType, unitFrame, buildingDraw } from "./sprites";

// The HUD is a translucent holy-grail overlay declared in client.html (markup +
// CSS); this module only wires the dynamic bits (see wireHud).  UI gives the
// chrome thickness of each edge in px and must match the --ui-* CSS variables in
// client.html — the minimap math below reads it.
const UI = { top: 32, right: 150, bottom: 120, left: 120 };
const MINIMAP_SZ  = UI.left;  // minimap is a square filling the bottom-left cell

// Icon sheet geometry: 46×38 frames in a 5-column grid (icons.png is 230 wide).
const ICON_W = (iconsJson as any).frameWidth  as number;   // 46
const ICON_H = (iconsJson as any).frameHeight as number;   // 38
const ICON_COLS = 5;
const ICON_FRAMES = (iconsJson as any).frames as Record<string, number>;

/** CSS background-position that crops icons.png to the given icon-frame key. */
function iconBgPos(iconKey: string): string {
    const idx = ICON_FRAMES[iconKey] ?? 0;
    const col = idx % ICON_COLS, row = Math.floor(idx / ICON_COLS);
    return `-${col * ICON_W}px -${row * ICON_H}px`;
}
const CAM_SPEED  = 8;    // pixels per frame

// Position-interpolation cadence (feel knob).  Quantizes the lerp between
// snapshots into N sub-steps per 20 Hz tick instead of continuous 60 fps:
//   1 → no interpolation (snap to the latest snapshot; crunchy + zero latency)
//   2–4 → stepped, retro RTS cadence (smoother but not floaty)
//   high (≥TICK_MS·0.06 ≈ 30) → effectively continuous/smooth
const INTERP_SUBSTEPS = 2;

// Cap on how fast the displayed sprite catches up to its authoritative position, in px/ms.
// A unit walks ~0.06 px/ms, so normal movement keeps up exactly (no feel change).  A settle
// *snap* (movement.ts) catches up at this rate: tuned so the tiny arrival hops (≤4px) resolve
// in ~one frame (crisp, no visible "slide") while the rare large hop still glides a touch
// instead of teleporting (~6px/frame at 60fps).  Render-only; never hashed.
const MAX_CATCHUP_PX_PER_MS = 0.25;

const SEL_COLOR  = 0x00ff00;

/** Drag-select result — stable unit-ids of the units under the selection box. */
export type SelectCallback = (uids: number[]) => void;

export class GameScene extends Phaser.Scene {
    // World-space graphics (scrolls with camera)
    private gfx!:    Phaser.GameObjects.Graphics;
    // Screen-space graphics (fixed — drag rect, UI bar, minimap)
    private uiGfx!:  Phaser.GameObjects.Graphics;

    /** Rolling render frame time (ms), EMA-smoothed in update().  The client shell reads
     *  this when assembling the perf sample — fps lives only on the main thread. */
    frameMs = 0;

    // Refs into the static HUD markup (client.html), grabbed in wireHud().
    private resourceCell!: HTMLDivElement;   // top-centre: gold / lumber / oil / food
    private portraitCell!: HTMLDivElement;   // bottom-centre: selected-unit portrait + stats
    // Chrome panels that capture pointer events — flipped to pointer-events:none
    // during a drag-select so the drag keeps tracking across them.
    private interactiveCells: HTMLDivElement[] = [];

    // Collapsible right-edge tweak panel.  tweakBodyEl is where future dev
    // controls get mounted; toggling .open animates it (CSS) and shrinks the frame.
    private tweakPaneEl!: HTMLDivElement;
    private tweakBodyEl!: HTMLDivElement;
    private tweakOpen = false;

    // Command card (DOM grid living in the bottom-right cell). View only — the
    // controller decides what card to show and what slot clicks mean.
    private cardEl!: HTMLDivElement;

    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

    // Received from startPhaser() via Phaser's init(data) mechanism
    private mapConfig:     { tilesetUrl: string; mapJson: any } | null = null;
    private chunkRenderer: ChunkRenderer | null = null;

    // Map dimensions in world pixels (set once map config is available)
    private mapPixelW = 0;
    private mapPixelH = 0;

    // Pre-rendered terrain backdrop for the minimap
    private minimapImg: Phaser.GameObjects.Image | null = null;

    // Fog of war — set by main.ts after scene boots
    myTeam: number = 0;
    // Per-tile visibility (0=UNEXPLORED, 1=EXPLORED, 2=VISIBLE).
    // tileExplored persists; tileVis is recomputed each frame from unit positions.
    private tileVis:      Uint8Array | null = null;
    private tileExplored: Uint8Array | null = null;
    private mapTileW = 0;
    private mapTileH = 0;

    // One Phaser Sprite per live unit / building — keyed by stable unit-id.
    private unitSprites = new Map<number, Phaser.GameObjects.Sprite>();
    private buildingSprites = new Map<number, Phaser.GameObjects.Sprite>();
    // Tileset name for the active map (used to pick building art)
    private tilesetName = "summer";

    // Latest per-tick snapshot from the sim worker — the sole source of entity
    // state.  Set by main.ts on each "render" message.
    private renderState: RenderState | null = null;
    // Locally-owned selection (stable unit-ids); selection is main-thread UI state.
    private selectedUids = new Set<number>();

    // ── Interpolation: lerp positions between the last two snapshots ──────────────
    // Previous snapshot's positions (uid → world FP) and the wall-clock time the
    // current snapshot arrived, so update() can smooth 20 Hz sim → 60 fps render.
    private prevPos = new Map<number, { x: number; y: number }>();
    // Smoothed display position (uid → world px); eases toward the interpolated target so a
    // one-tick settle snap glides instead of teleporting.
    private dispPos = new Map<number, { x: number; y: number }>();
    private snapAt  = 0;
    // Measured (EMA) real interval between snapshots — the interpolation period. Tracks the live
    // tick cadence so interpolation stays correct as game speed (or tab-throttling) changes it,
    // without the renderer needing to know the speed. Seeded to one nominal tick.
    private snapInterval = TICK_MS;

    // ── Prediction: own-unit facing/marker overlay (uid → prediction) ────────────
    // Shared by reference with main.ts, which adds/removes entries; we just read it.
    private prediction = new Map<number, UnitPrediction>();
    // Raw input events — no semantics, no mode state.  main.ts routes these to
    // the command-card controller, which decides what they mean.
    onSelect: SelectCallback | null = null;
    /** Left-click on the map. Return true if consumed (skip selection). */
    onPrimaryClick:   ((wxFP: number, wyFP: number) => boolean) | null = null;
    /** Right-click on the map. */
    onSecondaryClick: ((wxFP: number, wyFP: number) => void) | null = null;
    /** A command-card slot was clicked (grid index 0-8). */
    onSlot:   ((index: number) => void) | null = null;
    /** Escape key pressed. */
    onEscape: (() => void) | null = null;
    /** A letter key was pressed — a command-card hotkey. Return true if consumed. */
    onHotkey: ((letter: string) => boolean) | null = null;
    /** Cursor moved over the map (world FP). Drives the placement ghost. */
    onHover:  ((wxFP: number, wyFP: number) => void) | null = null;

    // Building-placement ghost (render-only); set via showPlacementGhost.
    private ghost: { tileX: number; tileY: number; fw: number; fh: number; valid: boolean } | null = null;

    // Drag-select state (screen coords)
    private drag = false;
    private sx = 0; private sy = 0;
    private ex = 0; private ey = 0;

    // Minimap drag-pan state
    private mmDragging = false;

    constructor() { super({ key: "game" }); }

    init(data: { tilesetUrl: string; mapJson: any }): void {
        if (data?.mapJson) this.mapConfig = data;
    }

    preload(): void {
        if (!this.mapConfig) return;
        const { tilesetUrl, mapJson } = this.mapConfig;
        const ts = mapJson.tilesets[0];
        // Load as spritesheet so individual tile GIDs address frames directly.
        this.load.spritesheet(ts.name, tilesetUrl, {
            frameWidth:  TILE_PX,
            frameHeight: TILE_PX,
            spacing:     ts.spacing ?? 0,
            margin:      ts.margin  ?? 0,
        });

        // All unit / building / construction spritesheets for this tileset, from
        // the data-driven sprite registry (one place, one convention).
        this.tilesetName = ts.name;
        for (const s of allSheets(ts.name)) {
            this.load.spritesheet(s.key, s.url, { frameWidth: s.frameW, frameHeight: s.frameH });
        }
    }

    create(): void {
        // ── Terrain chunk renderer ────────────────────────────────────────────
        if (this.mapConfig) {
            const { mapJson } = this.mapConfig;
            const ts = mapJson.tilesets[0];
            this.chunkRenderer = new ChunkRenderer(
                this,
                mapJson.layers.find((l: any) => l.type === "tilelayer").data,
                mapJson.width,
                mapJson.height,
                ts.name,
            );
            this.mapPixelW = mapJson.width  * mapJson.tilewidth;
            this.mapPixelH = mapJson.height * mapJson.tileheight;
            // The HUD is a translucent overlay, so the world renders edge-to-edge:
            // scroll bounds are simply the map size.
            this.cameras.main.setBounds(0, 0, this.mapPixelW, this.mapPixelH);

            this.mapTileW    = this.mapPixelW / TILE_PX;
            this.mapTileH    = this.mapPixelH / TILE_PX;
            this.tileVis     = new Uint8Array(this.mapTileW * this.mapTileH);
            this.tileExplored = new Uint8Array(this.mapTileW * this.mapTileH);

            this.createMinimapTexture(mapJson);
        }

        // ── Graphics layers ───────────────────────────────────────────────────
        // depth: terrain=-1, units(sprites)=0, overlays(gfx)=2, ui(uiGfx)=10
        this.gfx   = this.add.graphics().setDepth(2);
        this.uiGfx = this.add.graphics().setScrollFactor(0).setDepth(10);

        // ── Keyboard ──────────────────────────────────────────────────────────
        // Arrow keys pan (WC2/StarCraft style); letter keys are command-card
        // hotkeys, so WASD is intentionally NOT bound to panning.
        this.cursors = this.input.keyboard!.createCursorKeys();

        this.input.keyboard!.on("keydown-ESC", () => this.onEscape?.());

        // Letter keys → command-card hotkeys (A–Z only; let everything else,
        // e.g. the console's backtick, pass through untouched).
        this.input.keyboard!.on("keydown", (ev: KeyboardEvent) => {
            if (ev.key.length === 1 && /[a-zA-Z]/.test(ev.key)) this.onHotkey?.(ev.key);
        });

        // ── Pointer events ────────────────────────────────────────────────────
        this.input.mouse?.disableContextMenu();

        this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
            if (p.leftButtonDown()) {
                if (this.isInMinimap(p.x, p.y)) {
                    this.mmDragging = true;
                    this.panToMinimap(p.x, p.y);
                } else {
                    this.drag = true;
                    this.sx = p.x; this.sy = p.y;
                    this.ex = p.x; this.ey = p.y;
                    // Let the drag track across the perimeter cells (see method).
                    this.setHudDragMode(true);
                }
            }
        });

        this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
            if (this.mmDragging) {
                this.panToMinimap(p.x, p.y);
            } else if (this.drag) {
                this.ex = p.x; this.ey = p.y;
            }
            // Drive the placement ghost (game area only — not over the minimap).
            // Perimeter HUD cells capture their own pointer events, so the only
            // non-game region that reaches the canvas is the minimap.
            if (this.onHover && !this.isInMinimap(p.x, p.y)) {
                const w = this.cameras.main.getWorldPoint(p.x, p.y);
                this.onHover(w.x * FP, w.y * FP);
            }
        });

        this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
            if (this.mmDragging) {
                this.mmDragging = false;
            } else if (this.drag) {
                this.drag = false;
                this.setHudDragMode(false);
                this.finishSelect();
            }
            // Right-clicks only fire in the game area, not over the minimap.
            if (p.rightButtonReleased() && !this.isInMinimap(p.x, p.y)) {
                const w = this.cameras.main.getWorldPoint(p.x, p.y);
                this.onSecondaryClick?.(w.x * FP, w.y * FP);
            }
        });

        // ── DOM HUD ───────────────────────────────────────────────────────────
        this.wireHud();
    }

    // ── HUD wiring ─────────────────────────────────────────────────────────────

    /** Grab refs into the static HUD markup (client.html) and attach the few
     *  dynamic behaviours: the tweak-panel toggle, the right-click guard, and the
     *  list of chrome panels flipped click-through during a drag-select.  The
     *  layout itself is entirely declarative HTML/CSS. */
    private wireHud(): void {
        this.resourceCell = document.querySelector<HTMLDivElement>("#hud-resources")!;
        this.portraitCell = document.querySelector<HTMLDivElement>("#hud-portrait")!;
        this.cardEl       = document.querySelector<HTMLDivElement>("#hud-card")!;
        this.tweakPaneEl  = document.querySelector<HTMLDivElement>("#hud-tweak")!;
        this.tweakBodyEl  = document.querySelector<HTMLDivElement>("#hud-tweak-body")!;

        // Chrome panels capture pointer events; flipped click-through during a drag.
        this.interactiveCells = Array.from(
            document.querySelectorAll<HTMLDivElement>(".hud-chrome"),
        );

        // Right-click on the chrome shouldn't pop the browser context menu.
        document.querySelector("#hud")!
            .addEventListener("contextmenu", e => e.preventDefault());

        // Tweak-panel toggle (collapsed by default; .open is added/removed here).
        this.tweakPaneEl.querySelector(".hud-tweak-handle")!
            .addEventListener("click", () => this.setTweakOpen(!this.tweakOpen));
    }

    /** Show/hide the tweak pane — CSS animates the width (and shrinks the frame). */
    private setTweakOpen(open: boolean): void {
        this.tweakOpen = open;
        this.tweakPaneEl.classList.toggle("open", open);
        (this.tweakPaneEl.firstElementChild as HTMLElement).textContent = open ? "›" : "‹";
    }

    /** Enter/leave drag-select mode.  While dragging, the perimeter cells stop
     *  capturing pointer events so the drag keeps tracking across them (Phaser
     *  owns the pointer from pointerdown, but a cell with pointer-events:auto
     *  would otherwise intercept the moves and freeze the rect at its edge). */
    private setHudDragMode(on: boolean): void {
        for (const c of this.interactiveCells) c.style.pointerEvents = on ? "none" : "auto";
        if (!on) this.cardEl.style.opacity = "1";   // restore the card fade
    }

    // ── Command card (view only) ─────────────────────────────────────────────────

    /** Draw a pre-computed command card (null = hide).  Slot clicks emit onSlot. */
    showCommandCard(card: CommandCard | null): void {
        const el = this.cardEl;
        el.replaceChildren();
        if (!card) { el.style.display = "none"; return; }
        el.style.display = "grid";

        card.forEach((ability, index) => {
            const cell = document.createElement("div");
            Object.assign(cell.style, {
                width: `${ICON_W}px`, height: `${ICON_H}px`,
                position: "relative", boxSizing: "border-box",
            });
            if (ability) {
                Object.assign(cell.style, {
                    backgroundImage: `url(${iconsUrl})`,
                    backgroundPosition: iconBgPos(ability.icon),
                    backgroundRepeat: "no-repeat",
                    imageRendering: "pixelated",
                    border: "1px solid #2a4", cursor: "pointer",
                });
                cell.title = ability.hotkey.length === 1
                    ? `${ability.label} (${ability.hotkey})` : ability.label;
                if (ability.hotkey.length === 1) {
                    const k = document.createElement("span");
                    k.textContent = ability.hotkey;
                    Object.assign(k.style, {
                        position: "absolute", left: "1px", bottom: "0px",
                        font: "bold 10px monospace", color: "#ff4",
                        textShadow: "0 0 2px #000, 0 0 2px #000", pointerEvents: "none",
                    });
                    cell.appendChild(k);
                }
                cell.addEventListener("click", () => this.onSlot?.(index));
            } else {
                cell.style.border = "1px solid rgba(255,255,255,0.10)";
                cell.style.background = "rgba(0,0,0,0.25)";
            }
            el.appendChild(cell);
        });
    }

    // ── Fog of war ────────────────────────────────────────────────────────────

    /**
     * Recompute per-tile visibility for myTeam and push it to the ChunkRenderer.
     *
     * tileVis values:
     *   0 = UNEXPLORED — never seen; solid ~100% black
     *   1 = EXPLORED   — seen before but not current view; 50% dim terrain
     *   2 = VISIBLE    — currently in sight; full terrain + fog edge tiles
     */
    private updateFow(units: RenderUnit[]): void {
        if (!this.chunkRenderer || !this.tileVis || !this.tileExplored) return;

        const mapW = this.mapTileW;
        const mapH = this.mapTileH;
        const vis  = this.tileVis;
        const exp  = this.tileExplored;

        // Start from explored state, then mark current visibility on top
        for (let i = 0; i < vis.length; i++) vis[i] = exp[i];

        // Mark tiles currently in sight of any own unit as VISIBLE (2)
        for (const u of units) {
            if (u.team !== this.myTeam) continue;
            // Per-unit sight (unitSight), matching the sim's vision/visibility.
            const sight = unitSight(u.type);
            const utx = (u.x / FP / TILE_PX) | 0;
            const uty = (u.y / FP / TILE_PX) | 0;
            const tx0 = Math.max(0,       utx - sight);
            const tx1 = Math.min(mapW - 1, utx + sight);
            const ty0 = Math.max(0,       uty - sight);
            const ty1 = Math.min(mapH - 1, uty + sight);
            for (let ty = ty0; ty <= ty1; ty++) {
                for (let tx = tx0; tx <= tx1; tx++) {
                    const _dx = tx - utx, _dy = ty - uty;
                    // Dodecagonal metric — the single source of truth shared with the sim
                    // (world.ts isTileVisible / computeVisibleUids). Keeps the drawn fog
                    // identical to actual gameplay vision at any radius.
                    if (inRange(_dx, _dy, sight)) {
                        vis[ty * mapW + tx] = 2;
                    }
                }
            }
        }

        // Persist newly visible tiles as explored
        for (let i = 0; i < vis.length; i++) {
            if (vis[i] === 2) exp[i] = 1;
        }

        this.chunkRenderer.updateFog(vis, mapW, mapH);
    }

    // ── Minimap terrain pre-render ────────────────────────────────────────────

    /**
     * Bake the entire map at minimap resolution onto an off-screen canvas once,
     * register it as a Phaser texture, and show it as a scrollFactor(0) Image
     * behind the unit dots.  Uses the raw tileset HTMLImageElement so that
     * canvas drawImage handles the downscale — no Phaser stamp loop needed.
     */
    private createMinimapTexture(mapJson: any): void {
        const ts       = mapJson.tilesets[0];
        const tsName   = ts.name as string;
        const spacing  = (ts.spacing as number) ?? 0;
        const margin   = (ts.margin  as number) ?? 0;
        const mapW     = mapJson.width  as number;
        const mapH     = mapJson.height as number;
        const tileData = (mapJson.layers as any[])
            .find((l: any) => l.type === "tilelayer").data as number[];

        const srcImage = this.textures.get(tsName).getSourceImage() as HTMLImageElement;
        const tsColumns = Math.floor(
            (srcImage.width - 2 * margin + spacing) / (TILE_PX + spacing),
        );

        // ── Step 1: draw each tile as 1px onto a mapW×mapH canvas ──────────────
        // This lets the browser average all 32×32 source pixels down to a single
        // representative colour per tile — far better than a direct 4096→120 scale.
        const inter    = document.createElement("canvas");
        inter.width    = mapW;
        inter.height   = mapH;
        const ictx     = inter.getContext("2d")!;
        ictx.imageSmoothingEnabled = true;
        ictx.imageSmoothingQuality = "high";
        ictx.fillStyle = "#000000";
        ictx.fillRect(0, 0, mapW, mapH);

        for (let row = 0; row < mapH; row++) {
            for (let col = 0; col < mapW; col++) {
                const gid = tileData[row * mapW + col];
                if (gid < 1) continue;

                const frame  = gid - 1;
                const srcCol = frame % tsColumns;
                const srcRow = Math.floor(frame / tsColumns);
                const srcX   = margin + srcCol * (TILE_PX + spacing);
                const srcY   = margin + srcRow * (TILE_PX + spacing);

                ictx.drawImage(srcImage, srcX, srcY, TILE_PX, TILE_PX, col, row, 1, 1);
            }
        }

        // ── Step 2: scale the 1px-per-tile canvas to MINIMAP_SZ ─────────────
        // If the map is larger than MINIMAP_SZ use smooth downscaling; if smaller
        // use nearest-neighbour upscaling to keep the pixelated look.
        const canvas  = document.createElement("canvas");
        canvas.width  = MINIMAP_SZ;
        canvas.height = MINIMAP_SZ;
        const ctx     = canvas.getContext("2d")!;
        const needsDownscale = mapW > MINIMAP_SZ;
        ctx.imageSmoothingEnabled = needsDownscale;
        if (needsDownscale) ctx.imageSmoothingQuality = "high";
        ctx.drawImage(inter, 0, 0, MINIMAP_SZ, MINIMAP_SZ);

        // Re-register each restart (hot-reload etc.)
        if (this.textures.exists("minimapTerrain")) this.textures.remove("minimapTerrain");
        this.textures.addCanvas("minimapTerrain", canvas);

        this.minimapImg = this.add.image(0, 0, "minimapTerrain")
            .setScrollFactor(0)
            .setOrigin(0, 0)
            .setDepth(9);   // below uiGfx (depth 10) which draws dots + viewport rect
    }

    // ── Minimap helpers ───────────────────────────────────────────────────────

    /** True if screen point (sx, sy) falls inside the minimap zone. */
    private isInMinimap(sx: number, sy: number): boolean {
        return sx >= 0 && sx < MINIMAP_SZ
            && sy >= this.scale.height - UI.bottom
            && sy < this.scale.height;
    }

    /** Pan the main camera so the clicked minimap point is centred on screen. */
    private panToMinimap(sx: number, sy: number): void {
        if (!this.mapPixelW || !this.mapPixelH) return;
        const scaleX = MINIMAP_SZ / this.mapPixelW;
        const scaleY = MINIMAP_SZ / this.mapPixelH;
        const wx = sx / scaleX;
        const wy = (sy - (this.scale.height - UI.bottom)) / scaleY;
        const cam = this.cameras.main;
        cam.scrollX = wx - cam.width  / 2;
        cam.scrollY = wy - cam.height / 2;
    }

    /** Draw minimap background, unit dots, camera viewport rect, and border. */
    private drawMinimap(units: RenderUnit[]): void {
        if (!this.mapPixelW || !this.mapPixelH) return;

        const sh     = this.scale.height;
        const mmTop  = sh - UI.bottom;
        const scaleX = MINIMAP_SZ / this.mapPixelW;
        const scaleY = MINIMAP_SZ / this.mapPixelH;

        // Unit dots — 3×3 px squares, coloured by team.
        // Enemy units are hidden unless their chunk is currently visible to myTeam.
        for (const u of units) {
            const wx = u.x / FP;
            const wy = u.y / FP;
            if (u.team !== this.myTeam) {
                const tx = (wx / TILE_PX) | 0;
                const ty = (wy / TILE_PX) | 0;
                if (!this.tileVis || this.tileVis[ty * this.mapTileW + tx] < 2) continue;
            }
            const dx = wx * scaleX;
            const dy = mmTop + wy * scaleY;
            this.uiGfx.fillStyle(u.team === 0 ? 0x00cc44 : 0xdd2222, 1);
            this.uiGfx.fillRect(dx - 1, dy - 1, 3, 3);
        }

        // Camera viewport rect.  The world now fills the whole canvas (the HUD is
        // a translucent overlay), so the visible region is the full cam extent.
        const cam = this.cameras.main;
        const vx  = cam.scrollX * scaleX;
        const vy  = mmTop + cam.scrollY * scaleY;
        const vw  = cam.width  * scaleX;
        const vh  = cam.height * scaleY;
        this.uiGfx.lineStyle(1, 0xffffff, 0.8);
        this.uiGfx.strokeRect(vx, vy, vw, vh);

        // Border
        this.uiGfx.lineStyle(1, 0x444466, 1);
        this.uiGfx.strokeRect(0, mmTop, MINIMAP_SZ, MINIMAP_SZ);
    }

    override update(_time: number, delta: number): void {
        // Rolling render frame time (ms) for the perf overlay — EMA to smooth jitter.
        this.frameMs += (delta - this.frameMs) * 0.1;

        // ── Terrain chunks ────────────────────────────────────────────────────
        this.chunkRenderer?.update(this.cameras.main);

        // ── Camera scroll ─────────────────────────────────────────────────────
        const cam = this.cameras.main;
        if (this.cursors.left.isDown)  cam.scrollX -= CAM_SPEED;
        if (this.cursors.right.isDown) cam.scrollX += CAM_SPEED;
        if (this.cursors.up.isDown)    cam.scrollY -= CAM_SPEED;
        if (this.cursors.down.isDown)  cam.scrollY += CAM_SPEED;

        if (!this.renderState) return;
        const units = this.renderState.units;
        this.updateFow(units);
        this.gfx.clear();
        this.uiGfx.clear();

        // The translucent DOM grid provides the HUD backgrounds; the canvas only
        // draws the minimap contents + the drag rect on top of the world.
        const sw = this.scale.width;
        const sh = this.scale.height;
        // Keep the minimap terrain backdrop pinned to the bottom-left on resize.
        this.minimapImg?.setY(sh - UI.bottom);

        // ── Minimap ───────────────────────────────────────────────────────────
        this.drawMinimap(units);

        // ── Units (world space) ───────────────────────────────────────────────
        const now        = Date.now();
        // Interpolation factor: 0 just after a snapshot arrives → 1 a tick later.
        // Quantized into INTERP_SUBSTEPS sub-steps for a stepped, less-floaty feel
        // (1 = snap to the latest snapshot, no interpolation).
        const raw        = Math.min(1, (performance.now() - this.snapAt) / this.snapInterval);
        const t          = INTERP_SUBSTEPS <= 1 ? 1 : Math.round(raw * INTERP_SUBSTEPS) / INTERP_SUBSTEPS;
        const maxCatchup = MAX_CATCHUP_PX_PER_MS * delta;   // per-frame display catch-up cap (px)
        const currentSet = new Set(units.map(u => u.uid));

        // Destroy sprites for units / buildings that no longer exist
        for (const [uid, sprite] of this.unitSprites) {
            if (!currentSet.has(uid)) {
                sprite.destroy();
                this.unitSprites.delete(uid);
                this.dispPos.delete(uid);
            }
        }
        for (const [uid, sprite] of this.buildingSprites) {
            if (!currentSet.has(uid)) {
                sprite.destroy();
                this.buildingSprites.delete(uid);
            }
        }

        for (const u of units) {
            // Buildings render as their own sprite (separate pool, no walk cycle).
            if (u.fw > 0) { this.drawBuilding(u); continue; }

            // Position: lerp from the previous snapshot toward this one, then ease the displayed
            // sprite toward that target at a capped speed so a one-tick settle snap glides in.
            const prev = this.prevPos.get(u.uid);
            const tgx = (prev ? prev.x + (u.x - prev.x) * t : u.x) / FP;
            const tgy = (prev ? prev.y + (u.y - prev.y) * t : u.y) / FP;
            let disp = this.dispPos.get(u.uid);
            if (!disp) { disp = { x: tgx, y: tgy }; this.dispPos.set(u.uid, disp); }
            const ddx = tgx - disp.x, ddy = tgy - disp.y, dd = Math.hypot(ddx, ddy);
            if (dd > maxCatchup) { disp.x += ddx * maxCatchup / dd; disp.y += ddy * maxCatchup / dd; }
            else                 { disp.x = tgx; disp.y = tgy; }
            const px = disp.x, py = disp.y;

            // Facing/animation: a pending local prediction overrides the snapshot
            // (instant turn) until the authoritative state catches up.
            const pred   = this.prediction.get(u.uid);
            const dir    = pred ? pred.dir : u.dir;
            const moving = pred ? true : !!u.moving;

            // ── Sprite + frame from the registry (keyed by unit type) ─────────
            // Units without sprite data fall back to the team worker sheet.
            const typeName = unitTypeName(u.type);
            let sheet = sheetForType(typeName, this.tilesetName);
            let drawType = typeName;
            if (!sheet) { drawType = u.team === 0 ? "unit-peasant" : "unit-peon"; sheet = sheetForType(drawType, this.tilesetName)!; }
            const key = sheet.key;
            const { frame, flipX } = unitFrame(drawType, dir, moving, now);

            let sprite = this.unitSprites.get(u.uid);
            if (!sprite) {
                sprite = this.add.sprite(px, py, key, frame).setDepth(0);
                this.unitSprites.set(u.uid, sprite);
            } else {
                sprite.setPosition(px, py);
                sprite.setTexture(key, frame);
            }
            sprite.setFlipX(flipX);

            // ── Selection ring ────────────────────────────────────────────────
            if (this.selectedUids.has(u.uid)) {
                // Box matches the unit's own collision size (32×32 ground, 64×64 ships/flyers).
                const [shw, shh] = unitBoxHalfPx(u.type);
                this.gfx.lineStyle(1.5, SEL_COLOR, 1);
                this.gfx.strokeRect(px - shw, py - shh, shw * 2, shh * 2);
            }

            // ── Move-target dot ────────────────────────────────────────────────
            // Predicted target shows instantly; otherwise the authoritative one.
            if (pred) {
                this.gfx.fillStyle(0xffffff, 0.3);
                this.gfx.fillCircle(pred.mtx / FP, pred.mty / FP, 3);
            } else if (u.mtActive) {
                this.gfx.fillStyle(0xffffff, 0.3);
                this.gfx.fillCircle(u.mtx / FP, u.mty / FP, 3);
            }
        }

        // ── Building-placement ghost (world space) ────────────────────────────
        if (this.ghost) {
            const { tileX, tileY, fw, fh, valid } = this.ghost;
            const color = valid ? 0x33ff33 : 0xff3333;
            const x = tileX * TILE_PX, y = tileY * TILE_PX, w = fw * TILE_PX, h = fh * TILE_PX;
            this.gfx.fillStyle(color, 0.28);
            this.gfx.fillRect(x, y, w, h);
            this.gfx.lineStyle(1.5, color, 0.9);
            this.gfx.strokeRect(x, y, w, h);
        }

        // ── Drag-select rect (screen space) ───────────────────────────────────
        if (this.drag) {
            this.uiGfx.lineStyle(1, 0x88ff88, 0.8);
            this.uiGfx.strokeRect(
                Math.min(this.sx, this.ex), Math.min(this.sy, this.ey),
                Math.abs(this.ex - this.sx), Math.abs(this.ey - this.sy),
            );
            // Fade the command card when the drag sweeps into its cell so the
            // selection box / units underneath stay visible.
            const dr = Math.max(this.sx, this.ex), db = Math.max(this.sy, this.ey);
            const overCard = dr >= sw - UI.right && db >= sh - UI.bottom;
            this.cardEl.style.opacity = overCard ? "0.2" : "1";
        }
    }

    /** Push the latest worker snapshot.  Rolls the current positions into the
     *  interpolation baseline so update() can lerp toward the new snapshot. */
    setRenderState(state: RenderState): void {
        if (this.renderState) {
            this.prevPos.clear();
            for (const u of this.renderState.units) this.prevPos.set(u.uid, { x: u.x, y: u.y });
        }
        this.renderState = state;
        const now = performance.now();
        // Track the real gap between snapshots (EMA-smoothed, sanity-clamped) so interpolation
        // matches the current tick cadence — game speed changes it; a stalled tab inflates it.
        if (this.snapAt > 0) {
            const dt = now - this.snapAt;
            if (dt > 0 && dt < 1000) this.snapInterval = this.snapInterval * 0.8 + dt * 0.2;
        }
        this.snapAt = now;
    }

    /** Share the live prediction map (main.ts mutates it; we read it each frame). */
    setPrediction(prediction: Map<number, UnitPrediction>): void { this.prediction = prediction; }

    /** Update the locally-owned selection (stable unit-ids) for selection rings. */
    setSelectedUids(uids: Set<number>): void { this.selectedUids = uids; }

    /** Toggle the targeting (crosshair) cursor for armed abilities. */
    setTargetingCursor(on: boolean): void {
        this.input.setDefaultCursor(on ? "crosshair" : "default");
    }

    /** Set (or clear, with null) the building-placement ghost. Drawn in update(). */
    showPlacementGhost(ghost: { tileX: number; tileY: number; fw: number; fh: number; valid: boolean } | null): void {
        this.ghost = ghost;
    }

    /** Render a building: a staged construction-site sprite while building, then
     *  the finished building (frame 0).  Footprint selection box; coloured-rect
     *  fallback if a texture is unavailable. */
    private drawBuilding(u: RenderUnit): void {
        const w = u.fw * TILE_PX, h = u.fh * TILE_PX;
        const cx = u.x / FP, cy = u.y / FP;
        const left = cx - w / 2, top = cy - h / 2;
        const typeName = unitTypeName(u.type);

        // Registry decides texture/frame/anchor from construction progress.
        const { key, frame, centered } = buildingDraw(typeName, u.buildLeft, unitBuildTicks(u.type));

        if (this.textures.exists(key)) {
            let spr = this.buildingSprites.get(u.uid);
            if (!spr) { spr = this.add.sprite(0, 0, key, 0).setDepth(0); this.buildingSprites.set(u.uid, spr); }
            const maxFrame = this.textures.get(key).frameTotal - 2;   // exclude __BASE
            spr.setTexture(key, Math.min(frame, Math.max(0, maxFrame)));
            if (centered) spr.setOrigin(0.5, 0.5).setPosition(cx, cy);   // small site, centred on footprint
            else          spr.setOrigin(0, 0).setPosition(left, top);     // building fills footprint
        } else {
            // Texture missing — coloured footprint rect fallback.
            const color = u.team === 0 ? 0x3366cc : 0xcc3333;
            this.gfx.fillStyle(color, u.buildLeft > 0 ? 0.35 : 0.7);
            this.gfx.fillRect(left, top, w, h);
            this.gfx.lineStyle(2, 0x000000, 0.8);
            this.gfx.strokeRect(left, top, w, h);
        }

        // Selection box around the footprint
        if (this.selectedUids.has(u.uid)) {
            this.gfx.lineStyle(2, SEL_COLOR, 1);
            this.gfx.strokeRect(left - 2, top - 2, w + 4, h + 4);
        }
    }

    private finishSelect(): void {
        if (!this.onSelect) return;

        // An armed ability consumes the click as its target — no selection change.
        const cam  = this.cameras.main;
        if (this.onPrimaryClick) {
            const cp = cam.getWorldPoint(this.ex, this.ey);
            if (this.onPrimaryClick(cp.x * FP, cp.y * FP)) return;
        }

        // Convert screen-space drag corners to world space
        const tl   = cam.getWorldPoint(Math.min(this.sx, this.ex), Math.min(this.sy, this.ey));
        const br   = cam.getWorldPoint(Math.max(this.sx, this.ex), Math.max(this.sy, this.ey));
        const x0 = tl.x * FP, y0 = tl.y * FP;
        const x1 = br.x * FP, y1 = br.y * FP;

        const hits: number[] = [];
        for (const u of this.renderState?.units ?? []) {
            if (u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1) hits.push(u.uid);
        }

        // Single click with no drag → deselect all
        if (Math.abs(this.ex - this.sx) < 4 && Math.abs(this.ey - this.sy) < 4 && hits.length === 0) {
            this.onSelect([]);
        } else {
            this.onSelect(hits);
        }
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
            // game.scene.add(key, class, autoStart, initData)
            // Phaser passes initData to init() before preload()
            game.scene.add("game", GameScene, true, mapConfig);
            const scene = game.scene.getScene("game") as GameScene;
            scene.events.once("create", () => resolve(scene));
        });
    });
}
