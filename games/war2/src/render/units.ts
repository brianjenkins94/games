/**
 * Entity drawing — the per-frame loop that turns the latest sim snapshot into Phaser sprites: position
 * interpolation, sprite lifecycle (spawn/reuse/destroy), facing/animation, selection rings, move-target
 * dots, and building sprites.  Split out of renderer.ts's update().
 */
import { FP } from "../game/components";
import { TILE_PX } from "./ChunkRenderer";
import type { RenderUnit } from "../worker/ipc";
import { unitTypeName, unitBuildTicks, unitBoxHalfPx } from "../game/unitTypes";
import { sheetForType, constructionSheet, unitFrame, buildingDraw, type SheetDef } from "./sprites";
import type { RendererState } from "./renderer";

/** Lazily load a spritesheet the first time an entity needs it (replaces the old eager bulk preload of
 *  all ~127 registered sheets).  Returns true once the texture is ready to draw.  Phaser's loader runs
 *  after boot, so we queue the sheet and (re)start the loader; the texture lands a frame or two later —
 *  callers skip (units) or fall back to a rect (buildings) until then. */
function ensureSheet(renderer: RendererState, sheet: SheetDef): boolean {
    const scene = renderer.scene;
    if (scene.textures.exists(sheet.key)) return true;
    if (!renderer.pendingSheets.has(sheet.key)) {
        renderer.pendingSheets.add(sheet.key);
        scene.load.spritesheet(sheet.key, sheet.url, { frameWidth: sheet.frameW, frameHeight: sheet.frameH });
        if (!scene.load.isLoading()) scene.load.start();
    }
    return false;
}

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

const SEL_COLOR = 0x00ff00;
// Building sprites sit just below the unit layer (units depth 0) so a unit overlapping a building's
// edge draws in front of it; still above terrain (depth -1).
const BUILDING_DEPTH = -0.5;

/** Draw all units + buildings for this frame: cull dead sprites, then interpolate/animate the rest.
 *  `delta` is the frame time (ms) — drives the display catch-up cap. */
export function drawEntities(renderer: RendererState, units: RenderUnit[], delta: number): void {
    const now        = Date.now();
    // Interpolation factor: 0 just after a snapshot arrives → 1 a tick later.
    // Quantized into INTERP_SUBSTEPS sub-steps for a stepped, less-floaty feel
    // (1 = snap to the latest snapshot, no interpolation).
    const raw        = Math.min(1, (performance.now() - renderer.snapAt) / renderer.snapInterval);
    const t          = INTERP_SUBSTEPS <= 1 ? 1 : Math.round(raw * INTERP_SUBSTEPS) / INTERP_SUBSTEPS;
    const maxCatchup = MAX_CATCHUP_PX_PER_MS * delta;   // per-frame display catch-up cap (px)
    const currentSet = new Set(units.map(u => u.uid));

    // Destroy sprites for units / buildings that no longer exist
    for (const [uid, sprite] of renderer.unitSprites) {
        if (!currentSet.has(uid)) {
            sprite.destroy();
            renderer.unitSprites.delete(uid);
            renderer.dispPos.delete(uid);
        }
    }
    for (const [uid, sprite] of renderer.buildingSprites) {
        if (!currentSet.has(uid)) {
            sprite.destroy();
            renderer.buildingSprites.delete(uid);
        }
    }

    for (const u of units) {
        // Buildings render as their own sprite (separate pool, no walk cycle).
        if (u.fw > 0) { drawBuilding(renderer, u); continue; }

        // Position: lerp from the previous snapshot toward this one, then ease the displayed
        // sprite toward that target at a capped speed so a one-tick settle snap glides in.
        const prev = renderer.prevPos.get(u.uid);
        const tgx = (prev ? prev.x + (u.x - prev.x) * t : u.x) / FP;
        const tgy = (prev ? prev.y + (u.y - prev.y) * t : u.y) / FP;
        let disp = renderer.dispPos.get(u.uid);
        if (!disp) { disp = { x: tgx, y: tgy }; renderer.dispPos.set(u.uid, disp); }
        const ddx = tgx - disp.x, ddy = tgy - disp.y, dd = Math.hypot(ddx, ddy);
        if (dd > maxCatchup) { disp.x += ddx * maxCatchup / dd; disp.y += ddy * maxCatchup / dd; }
        else                 { disp.x = tgx; disp.y = tgy; }
        const px = disp.x, py = disp.y;

        // Facing/animation: a pending local prediction overrides the snapshot
        // (instant turn) until the authoritative state catches up.
        const pred   = renderer.prediction.get(u.uid);
        const dir    = pred ? pred.dir : u.dir;
        const moving = pred ? true : !!u.moving;

        // ── Sprite + frame from the registry (keyed by unit type) ─────────
        // Units without sprite data fall back to the team worker sheet.
        const typeName = unitTypeName(u.type);
        let sheet = sheetForType(typeName, renderer.tilesetName);
        let drawType = typeName;
        if (!sheet) { drawType = u.team === 0 ? "unit-peasant" : "unit-peon"; sheet = sheetForType(drawType, renderer.tilesetName)!; }
        const key = sheet.key;
        const { frame, flipX } = unitFrame(drawType, dir, moving, now);

        // Lazy-load this type's sheet on first sighting; skip drawing until it's ready (a frame or two).
        // dispPos was already updated above, so the sprite appears at the right interpolated spot.
        if (!ensureSheet(renderer, sheet)) continue;

        let sprite = renderer.unitSprites.get(u.uid);
        if (!sprite) {
            sprite = renderer.scene.add.sprite(px, py, key, frame).setDepth(0);
            renderer.unitSprites.set(u.uid, sprite);
        } else {
            sprite.setPosition(px, py);
            sprite.setTexture(key, frame);
        }
        sprite.setFlipX(flipX);

        // ── Selection ring ────────────────────────────────────────────────
        if (renderer.selectedUids.has(u.uid)) {
            // Box matches the unit's own collision size (32×32 ground, 64×64 ships/flyers).
            const [shw, shh] = unitBoxHalfPx(u.type);
            renderer.gfx.lineStyle(1.5, SEL_COLOR, 1);
            renderer.gfx.strokeRect(px - shw, py - shh, shw * 2, shh * 2);
        }

        // ── Move-target dot ────────────────────────────────────────────────
        // Predicted target shows instantly; otherwise the authoritative one.
        if (pred) {
            renderer.gfx.fillStyle(0xffffff, 0.3);
            renderer.gfx.fillCircle(pred.mtx / FP, pred.mty / FP, 3);
        } else if (u.mtActive) {
            renderer.gfx.fillStyle(0xffffff, 0.3);
            renderer.gfx.fillCircle(u.mtx / FP, u.mty / FP, 3);
        }
    }
}

/** Render a building: a staged construction-site sprite while building, then
 *  the finished building (frame 0).  Footprint selection box; coloured-rect
 *  fallback if a texture is unavailable. */
function drawBuilding(renderer: RendererState, u: RenderUnit): void {
    const w = u.fw * TILE_PX, h = u.fh * TILE_PX;
    const cx = u.x / FP, cy = u.y / FP;
    const left = cx - w / 2, top = cy - h / 2;
    const typeName = unitTypeName(u.type);

    // Registry decides texture/frame/anchor from construction progress.
    const { key, frame, centered } = buildingDraw(typeName, u.buildLeft, unitBuildTicks(u.type));

    // Kick the lazy load for whichever sheet this key needs (building vs construction site); the rect
    // fallback below covers the gap until the texture lands.
    const sheet = key.startsWith("con:")
        ? constructionSheet(key.slice(4), renderer.tilesetName)
        : sheetForType(typeName, renderer.tilesetName);
    if (sheet) ensureSheet(renderer, sheet);

    if (renderer.scene.textures.exists(key)) {
        let spr = renderer.buildingSprites.get(u.uid);
        if (!spr) { spr = renderer.scene.add.sprite(0, 0, key, 0).setDepth(BUILDING_DEPTH); renderer.buildingSprites.set(u.uid, spr); }
        const maxFrame = renderer.scene.textures.get(key).frameTotal - 2;   // exclude __BASE
        spr.setTexture(key, Math.min(frame, Math.max(0, maxFrame)));
        if (centered) spr.setOrigin(0.5, 0.5).setPosition(cx, cy);   // small site, centred on footprint
        else          spr.setOrigin(0, 0).setPosition(left, top);     // building fills footprint
    } else {
        // Texture missing — coloured footprint rect fallback.
        const color = u.team === 0 ? 0x3366cc : 0xcc3333;
        renderer.gfx.fillStyle(color, u.buildLeft > 0 ? 0.35 : 0.7);
        renderer.gfx.fillRect(left, top, w, h);
        renderer.gfx.lineStyle(2, 0x000000, 0.8);
        renderer.gfx.strokeRect(left, top, w, h);
    }

    // Selection box around the footprint
    if (renderer.selectedUids.has(u.uid)) {
        renderer.gfx.lineStyle(2, SEL_COLOR, 1);
        renderer.gfx.strokeRect(left - 2, top - 2, w + 4, h + 4);
    }
}
