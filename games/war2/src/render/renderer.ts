/**
 * Phaser renderer — reads sim state, draws it, emits input events.
 * No game logic here; no sim dependencies except reading component arrays.
 *
 * Viewport: canvas fills the window.  The camera scrolls over the full map.
 * A bottom UI bar (UI_BAR_H px) holds the minimap (bottom-left) and will
 * eventually hold the portrait panel and command card.
 * WASD / arrow keys pan the camera.
 *
 * Coordinate spaces:
 *   screen  — pixel offset from the canvas top-left corner (pointer events)
 *   world   — pixel offset from the map top-left corner (where units live)
 *   FP      — world * FP (integer fixed-point used by the sim)
 */
import Phaser from "phaser";
import { Position, Unit, MoveTarget, UnitAnim, Building, FP } from "../game/components";
import { inRange } from "../game/distance";
import { ChunkRenderer, TILE_PX } from "./ChunkRenderer";
// Command-card icon sheet.  Tileset-specific; the current map is winter, so we
// load the winter sheet.  TODO: follow the active map's tileset like tilesetUrl.
import iconsUrl   from "../assets/graphics/tilesets/winter/icons.png";
import iconsJson  from "../assets/icons.json";
import type { CommandCard } from "../game/abilities";
import { unitTypeName, unitBuildTicks } from "../game/unitTypes";
// Data-driven sprite registry — all unit/building/construction art resolution.
import { allSheets, sheetForType, unitFrame, buildingDraw } from "./sprites";

const UI_BAR_H    = 120;  // height of the bottom UI strip in px
const MINIMAP_SZ  = 120;  // minimap is a square, flush to bottom-left corner

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
const SIGHT_TILES = 4;    // render sight radius — MUST equal the sim's FOW_SIGHT_TILES
                          // (game/world.ts) or drawn fog will drift from real vision.
const CAM_SPEED  = 8;    // pixels per frame

const SEL_COLOR  = 0xffff00;
const SEL_RADIUS = 18;   // selection ring radius in world pixels

export interface HudData {
    serverTick: number;
    clientTick: number;
    rtt:        number;
    lead:       number;
    lastHash:   number;
    beatAge:    number;
}

export type SelectCallback = (eids: number[]) => void;

export class GameScene extends Phaser.Scene {
    // World-space graphics (scrolls with camera)
    private gfx!:    Phaser.GameObjects.Graphics;
    // Screen-space graphics (fixed — drag rect, UI bar, minimap)
    private uiGfx!:  Phaser.GameObjects.Graphics;
    private hudEl!: HTMLDivElement;

    // Command card (DOM overlay in the bottom-right of the UI bar). View only —
    // the controller decides what card to show and what slot clicks mean.
    private cardEl!: HTMLDivElement;

    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
    private wasd!:    Record<string, Phaser.Input.Keyboard.Key>;

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

    // One Phaser Sprite per live unit entity
    private unitSprites = new Map<number, Phaser.GameObjects.Sprite>();
    // One Phaser Sprite per live building entity
    private buildingSprites = new Map<number, Phaser.GameObjects.Sprite>();
    // Tileset name for the active map (used to pick building art)
    private tilesetName = "summer";

    // Injected by main.ts after scene boots
    getUnitEids: (() => number[]) | null = null;
    hud: HudData = { serverTick:0, clientTick:0, rtt:0, lead:0, lastHash:0, beatAge:0 };
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
            // Extend scroll bounds by UI_BAR_H so the camera can reach the bottom
            // edge of the map despite the UI bar overlaying the lower portion of
            // the canvas.
            this.cameras.main.setBounds(
                0, 0,
                this.mapPixelW,
                this.mapPixelH + UI_BAR_H,
            );

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
        this.cursors = this.input.keyboard!.createCursorKeys();
        this.wasd = this.input.keyboard!.addKeys({
            up: "W", left: "A", down: "S", right: "D",
        }) as Record<string, Phaser.Input.Keyboard.Key>;

        this.input.keyboard!.on("keydown-ESC", () => this.onEscape?.());

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
                }
            }
        });

        this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
            if (this.mmDragging) {
                this.panToMinimap(p.x, p.y);
            } else if (this.drag) {
                this.ex = p.x; this.ey = p.y;
            }
            // Drive the placement ghost (in the game area only).
            if (this.onHover && p.y < this.scale.height - UI_BAR_H) {
                const w = this.cameras.main.getWorldPoint(p.x, p.y);
                this.onHover(w.x * FP, w.y * FP);
            }
        });

        this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
            if (this.mmDragging) {
                this.mmDragging = false;
            } else if (this.drag) {
                this.drag = false;
                this.finishSelect();
            }
            // Right-clicks only fire in the game area, not the UI bar
            if (p.rightButtonReleased() && p.y < this.scale.height - UI_BAR_H) {
                const w = this.cameras.main.getWorldPoint(p.x, p.y);
                this.onSecondaryClick?.(w.x * FP, w.y * FP);
            }
        });

        // ── DOM HUD ───────────────────────────────────────────────────────────
        const container = this.game.canvas.parentElement!;
        container.style.position = "relative";

        this.hudEl = document.createElement("div");
        Object.assign(this.hudEl.style, {
            position: "absolute", top: "6px", left: "6px",
            background: "rgba(0,0,0,0.55)", color: "#cfc",
            fontFamily: "monospace", fontSize: "11px",
            padding: "6px 10px", borderRadius: "4px",
            lineHeight: "1.7", pointerEvents: "none", whiteSpace: "pre",
        });
        container.appendChild(this.hudEl);

        // ── DOM command card ────────────────────────────────────────────────────
        this.cardEl = document.createElement("div");
        Object.assign(this.cardEl.style, {
            position: "absolute", right: "8px", bottom: "6px",
            display: "none", gridTemplateColumns: `repeat(3, ${ICON_W}px)`,
            gridAutoRows: `${ICON_H}px`, gap: "4px",
        });
        container.appendChild(this.cardEl);
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
    private updateFow(eids: number[]): void {
        if (!this.chunkRenderer || !this.tileVis || !this.tileExplored) return;

        const mapW = this.mapTileW;
        const mapH = this.mapTileH;
        const vis  = this.tileVis;
        const exp  = this.tileExplored;

        // Start from explored state, then mark current visibility on top
        for (let i = 0; i < vis.length; i++) vis[i] = exp[i];

        // Mark tiles currently in sight of any own unit as VISIBLE (2)
        for (const eid of eids) {
            if (Unit.team[eid] !== this.myTeam) continue;
            const utx = (Position.x[eid] / FP / TILE_PX) | 0;
            const uty = (Position.y[eid] / FP / TILE_PX) | 0;
            const tx0 = Math.max(0,       utx - SIGHT_TILES);
            const tx1 = Math.min(mapW - 1, utx + SIGHT_TILES);
            const ty0 = Math.max(0,       uty - SIGHT_TILES);
            const ty1 = Math.min(mapH - 1, uty + SIGHT_TILES);
            for (let ty = ty0; ty <= ty1; ty++) {
                for (let tx = tx0; tx <= tx1; tx++) {
                    const _dx = tx - utx, _dy = ty - uty;
                    // Dodecagonal metric — the single source of truth shared with the sim
                    // (world.ts isTileVisible / computeVisibleUids). Keeps the drawn fog
                    // identical to actual gameplay vision at any radius.
                    if (inRange(_dx, _dy, SIGHT_TILES)) {
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
            && sy >= this.scale.height - UI_BAR_H
            && sy < this.scale.height;
    }

    /** Pan the main camera so the clicked minimap point is centred on screen. */
    private panToMinimap(sx: number, sy: number): void {
        if (!this.mapPixelW || !this.mapPixelH) return;
        const scaleX = MINIMAP_SZ / this.mapPixelW;
        const scaleY = MINIMAP_SZ / this.mapPixelH;
        const wx = sx / scaleX;
        const wy = (sy - (this.scale.height - UI_BAR_H)) / scaleY;
        const cam = this.cameras.main;
        cam.scrollX = wx - cam.width  / 2;
        cam.scrollY = wy - (cam.height - UI_BAR_H) / 2;
    }

    /** Draw minimap background, unit dots, camera viewport rect, and border. */
    private drawMinimap(eids: number[]): void {
        if (!this.mapPixelW || !this.mapPixelH) return;

        const sh     = this.scale.height;
        const mmTop  = sh - UI_BAR_H;
        const scaleX = MINIMAP_SZ / this.mapPixelW;
        const scaleY = MINIMAP_SZ / this.mapPixelH;

        // Unit dots — 3×3 px squares, coloured by team.
        // Enemy units are hidden unless their chunk is currently visible to myTeam.
        for (const eid of eids) {
            const wx   = Position.x[eid] / FP;
            const wy   = Position.y[eid] / FP;
            const team = Unit.team[eid];
            if (team !== this.myTeam) {
                const tx = (wx / TILE_PX) | 0;
                const ty = (wy / TILE_PX) | 0;
                if (!this.tileVis || this.tileVis[ty * this.mapTileW + tx] < 2) continue;
            }
            const dx = wx * scaleX;
            const dy = mmTop + wy * scaleY;
            this.uiGfx.fillStyle(team === 0 ? 0x00cc44 : 0xdd2222, 1);
            this.uiGfx.fillRect(dx - 1, dy - 1, 3, 3);
        }

        // Camera viewport rect.
        // cam.height covers the full canvas; the game area is the top portion
        // minus the UI bar, so subtract UI_BAR_H when computing the rect height.
        const cam = this.cameras.main;
        const vx  = cam.scrollX * scaleX;
        const vy  = mmTop + cam.scrollY * scaleY;
        const vw  = cam.width  * scaleX;
        const vh  = (cam.height - UI_BAR_H) * scaleY;
        this.uiGfx.lineStyle(1, 0xffffff, 0.8);
        this.uiGfx.strokeRect(vx, vy, vw, vh);

        // Border
        this.uiGfx.lineStyle(1, 0x444466, 1);
        this.uiGfx.strokeRect(0, mmTop, MINIMAP_SZ, MINIMAP_SZ);
    }

    override update(): void {
        // ── Terrain chunks ────────────────────────────────────────────────────
        this.chunkRenderer?.update(this.cameras.main);

        // ── Camera scroll ─────────────────────────────────────────────────────
        const cam = this.cameras.main;
        if (this.cursors.left.isDown  || this.wasd["left"].isDown)  cam.scrollX -= CAM_SPEED;
        if (this.cursors.right.isDown || this.wasd["right"].isDown) cam.scrollX += CAM_SPEED;
        if (this.cursors.up.isDown    || this.wasd["up"].isDown)    cam.scrollY -= CAM_SPEED;
        if (this.cursors.down.isDown  || this.wasd["down"].isDown)  cam.scrollY += CAM_SPEED;

        if (!this.getUnitEids) return;
        const eids = this.getUnitEids();
        this.updateFow(eids);
        this.gfx.clear();
        this.uiGfx.clear();

        // ── UI bar background (screen space) ──────────────────────────────────
        const sw = this.scale.width;
        const sh = this.scale.height;
        this.uiGfx.fillStyle(0x111122, 1);
        // Leave the minimap area (bottom-left) unfilled so the terrain image shows through
        this.uiGfx.fillRect(MINIMAP_SZ, sh - UI_BAR_H, sw - MINIMAP_SZ, UI_BAR_H);

        // Keep the terrain backdrop pinned to the bottom-left on resize
        this.minimapImg?.setY(sh - UI_BAR_H);

        // ── Minimap ───────────────────────────────────────────────────────────
        this.drawMinimap(eids);

        // ── Units (world space) ───────────────────────────────────────────────
        const now        = Date.now();
        const currentSet = new Set(eids);

        // Destroy sprites for units / buildings that no longer exist
        for (const [eid, sprite] of this.unitSprites) {
            if (!currentSet.has(eid)) {
                sprite.destroy();
                this.unitSprites.delete(eid);
            }
        }
        for (const [eid, sprite] of this.buildingSprites) {
            if (!currentSet.has(eid)) {
                sprite.destroy();
                this.buildingSprites.delete(eid);
            }
        }

        for (const eid of eids) {
            // Buildings render as their own sprite (separate pool, no walk cycle).
            if (Building.fw[eid] > 0) { this.drawBuilding(eid); continue; }

            const px        = Position.x[eid] / FP;
            const py        = Position.y[eid] / FP;
            const team      = Unit.team[eid];
            const sel       = Unit.selected[eid];
            const hasTarget = !!MoveTarget.active[eid];

            // ── Sprite + frame from the registry (keyed by unit type) ─────────
            // Units without sprite data fall back to the team worker sheet.
            const typeName = unitTypeName(Unit.type[eid]);
            let sheet = sheetForType(typeName, this.tilesetName);
            let drawType = typeName;
            if (!sheet) { drawType = team === 0 ? "unit-peasant" : "unit-peon"; sheet = sheetForType(drawType, this.tilesetName)!; }
            const key = sheet.key;
            const { frame, flipX } = unitFrame(drawType, UnitAnim.dir[eid], !!UnitAnim.moving[eid], now);

            let sprite = this.unitSprites.get(eid);
            if (!sprite) {
                sprite = this.add.sprite(px, py, key, frame).setDepth(0);
                this.unitSprites.set(eid, sprite);
            } else {
                sprite.setPosition(px, py);
                sprite.setTexture(key, frame);
            }
            sprite.setFlipX(flipX);

            // ── Selection ring ────────────────────────────────────────────────
            if (sel) {
                this.gfx.lineStyle(1.5, SEL_COLOR, 1);
                this.gfx.strokeCircle(px, py, SEL_RADIUS);
            }

            // ── Move-target dot ───────────────────────────────────────────────
            if (hasTarget) {
                this.gfx.fillStyle(0xffffff, 0.3);
                this.gfx.fillCircle(MoveTarget.tx[eid] / FP, MoveTarget.ty[eid] / FP, 3);
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
        }

        // ── HUD ───────────────────────────────────────────────────────────────
        const d = this.hud;
        this.hudEl.textContent =
            `serverTick  ${d.serverTick}\n` +
            `clientTick  ${d.clientTick}\n` +
            `rtt         ${d.rtt} ms\n` +
            `lead        ${d.lead} ticks\n` +
            `lastHash    0x${(d.lastHash >>> 0).toString(16).padStart(8,"0")}\n` +
            `beatAge     ${d.beatAge} ticks`;
    }

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
    private drawBuilding(eid: number): void {
        const w = Building.fw[eid] * TILE_PX, h = Building.fh[eid] * TILE_PX;
        const cx = Position.x[eid] / FP, cy = Position.y[eid] / FP;
        const left = cx - w / 2, top = cy - h / 2;
        const typeName = unitTypeName(Unit.type[eid]);

        // Registry decides texture/frame/anchor from construction progress.
        const { key, frame, centered } = buildingDraw(
            typeName, Building.buildLeft[eid], unitBuildTicks(Unit.type[eid]),
        );

        if (this.textures.exists(key)) {
            let spr = this.buildingSprites.get(eid);
            if (!spr) { spr = this.add.sprite(0, 0, key, 0).setDepth(0); this.buildingSprites.set(eid, spr); }
            const maxFrame = this.textures.get(key).frameTotal - 2;   // exclude __BASE
            spr.setTexture(key, Math.min(frame, Math.max(0, maxFrame)));
            if (centered) spr.setOrigin(0.5, 0.5).setPosition(cx, cy);   // small site, centred on footprint
            else          spr.setOrigin(0, 0).setPosition(left, top);     // building fills footprint
        } else {
            // Texture missing — coloured footprint rect fallback.
            const color = Unit.team[eid] === 0 ? 0x3366cc : 0xcc3333;
            this.gfx.fillStyle(color, Building.buildLeft[eid] > 0 ? 0.35 : 0.7);
            this.gfx.fillRect(left, top, w, h);
            this.gfx.lineStyle(2, 0x000000, 0.8);
            this.gfx.strokeRect(left, top, w, h);
        }

        // Selection box around the footprint
        if (Unit.selected[eid]) {
            this.gfx.lineStyle(2, SEL_COLOR, 1);
            this.gfx.strokeRect(left - 2, top - 2, w + 4, h + 4);
        }
    }

    private finishSelect(): void {
        if (!this.getUnitEids || !this.onSelect) return;

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
        for (const eid of this.getUnitEids()) {
            const px = Position.x[eid], py = Position.y[eid];
            if (px >= x0 && px <= x1 && py >= y0 && py <= y1) hits.push(eid);
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
