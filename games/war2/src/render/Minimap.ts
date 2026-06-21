/**
 * Minimap — the square in the bottom-left HUD cell.  Owns its pre-rendered terrain backdrop
 * (texture + Image) and draws the dynamic layer (unit dots + camera viewport rect + border) into the
 * scene's screen-space graphics each frame.  Extracted from GameScene so the scene stays a coordinator
 * rather than a god-object (same rationale as the world.ts split).
 *
 * It holds no map-dimension state: the scene remains the source of truth for the map's pixel size
 * (also used for camera bounds) and passes it into draw()/panCameraTo(); fog gating is supplied as a
 * `visibleTile` predicate so visibility state stays in the scene.
 */
import Phaser from "phaser";
import { FP, TILE_PX } from "../game/components";
import { unitBoxHalfPx } from "../game/unitTypes";
import type { RenderUnit } from "../worker/ipc";

export class Minimap {
    private img: Phaser.GameObjects.Image | null = null;

    /**
     * @param scene  owning Phaser scene (for textures / add / scale / cameras)
     * @param size   px side of the square (= the bottom-left HUD cell width)
     * @param bottom HUD bottom-bar height; the minimap is anchored at scale.height - bottom
     */
    constructor(private scene: Phaser.Scene, private size: number, private bottom: number) {}

    /**
     * (Re)build the terrain backdrop texture from a tile-GID array and (re)place the Image.
     * Two-step downscale: paint each tile as 1px onto a mapW×mapH canvas (lets the browser average each
     * 32×32 tile to one representative colour), then scale that to `size`.
     */
    rebuild(tileData: number[], mapW: number, mapH: number, tsName: string, spacing: number, margin: number): void {
        const srcImage = this.scene.textures.get(tsName).getSourceImage() as HTMLImageElement;
        const tsColumns = Math.floor(
            (srcImage.width - 2 * margin + spacing) / (TILE_PX + spacing),
        );

        // ── Step 1: draw each tile as 1px onto a mapW×mapH canvas ──────────────
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

        // ── Step 2: scale the 1px-per-tile canvas to `size` ─────────────────────
        // Larger-than-square map → smooth downscale; smaller → nearest-neighbour upscale (keeps pixels).
        const canvas  = document.createElement("canvas");
        canvas.width  = this.size;
        canvas.height = this.size;
        const ctx     = canvas.getContext("2d")!;
        const needsDownscale = mapW > this.size;
        ctx.imageSmoothingEnabled = needsDownscale;
        if (needsDownscale) ctx.imageSmoothingQuality = "high";
        ctx.drawImage(inter, 0, 0, this.size, this.size);

        // Re-register each restart (hot-reload etc.)
        if (this.scene.textures.exists("minimapTerrain")) this.scene.textures.remove("minimapTerrain");
        this.scene.textures.addCanvas("minimapTerrain", canvas);

        this.img?.destroy();   // replace any prior minimap (e.g. on a scenario map change)
        this.img = this.scene.add.image(0, this.scene.scale.height - this.bottom, "minimapTerrain")
            .setScrollFactor(0)
            .setOrigin(0, 0)
            .setDepth(9);   // below the screen-space gfx (depth 10) which draws dots + viewport rect
    }

    /** Keep the backdrop pinned to the bottom edge on resize. */
    reposition(): void { this.img?.setY(this.scene.scale.height - this.bottom); }

    /** True if a screen point (sx, sy) falls inside the minimap zone. */
    contains(sx: number, sy: number): boolean {
        const sh = this.scene.scale.height;
        return sx >= 0 && sx < this.size && sy >= sh - this.bottom && sy < sh;
    }

    /** Pan the main camera so the clicked minimap point is centred on screen. */
    panCameraTo(sx: number, sy: number, mapPixelW: number, mapPixelH: number): void {
        if (!mapPixelW || !mapPixelH) return;
        const scaleX = this.size / mapPixelW;
        const scaleY = this.size / mapPixelH;
        const wx = sx / scaleX;
        const wy = (sy - (this.scene.scale.height - this.bottom)) / scaleY;
        const cam = this.scene.cameras.main;
        cam.scrollX = wx - cam.width  / 2;
        cam.scrollY = wy - cam.height / 2;
    }

    /**
     * Draw unit dots, the camera viewport rect, and the border into `g` (screen-space graphics).
     * `visibleTile(tx,ty)` gates enemy dots by fog (true = currently visible to the viewing team).
     */
    draw(
        g: Phaser.GameObjects.Graphics, units: RenderUnit[],
        mapPixelW: number, mapPixelH: number, myTeam: number,
        visibleTile: (tx: number, ty: number) => boolean,
    ): void {
        if (!mapPixelW || !mapPixelH) return;

        const sh     = this.scene.scale.height;
        const mmTop  = sh - this.bottom;
        const scaleX = this.size / mapPixelW;
        const scaleY = this.size / mapPixelH;

        // Unit dots — sized to the unit's footprint × the map scale (so they read proportionally on a
        // tiny scenario map as well as a full one), with a 2px floor to stay visible when zoomed way out.
        // Enemy units are hidden unless their tile is currently visible to the viewing team.
        for (const u of units) {
            const wx = u.x / FP;
            const wy = u.y / FP;
            if (u.team !== myTeam) {
                const tx = (wx / TILE_PX) | 0;
                const ty = (wy / TILE_PX) | 0;
                if (!visibleTile(tx, ty)) continue;
            }
            const [hw, hh] = unitBoxHalfPx(u.type);
            const w = Math.max(2, 2 * hw * scaleX);
            const h = Math.max(2, 2 * hh * scaleY);
            const dx = wx * scaleX;
            const dy = mmTop + wy * scaleY;
            g.fillStyle(u.team === 0 ? 0x00cc44 : 0xdd2222, 1);
            g.fillRect(dx - w / 2, dy - h / 2, w, h);
        }

        // Camera viewport rect, clamped to the minimap square. The world fills the whole canvas, so the
        // visible region is the full cam extent — but on a tiny scenario map the cam sees well beyond the
        // map, which would balloon the rect past the minimap; clamp each edge to [0, size].
        const cam   = this.scene.cameras.main;
        const left   = Math.max(0,                 cam.scrollX * scaleX);
        const top    = Math.max(mmTop,             mmTop + cam.scrollY * scaleY);
        const right  = Math.min(this.size,         (cam.scrollX + cam.width)  * scaleX);
        const bottom = Math.min(mmTop + this.size, mmTop + (cam.scrollY + cam.height) * scaleY);
        g.lineStyle(1, 0xffffff, 0.8);
        g.strokeRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));

        // Border
        g.lineStyle(1, 0x444466, 1);
        g.strokeRect(0, mmTop, this.size, this.size);
    }
}
