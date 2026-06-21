/**
 * Entity drawing — the per-frame loop that turns the latest sim snapshot into Phaser sprites: position
 * interpolation, sprite lifecycle (spawn/reuse/destroy), facing/animation, selection rings, move-target
 * dots, and building sprites.  Split out of renderer.ts's update().
 */
import Phaser from "phaser";
import { FP } from "../game/components";
import { TILE_PX } from "./ChunkRenderer";
import type { RenderUnit } from "../worker/ipc";
import { unitTypeName, unitBuildTicks, unitBoxHalfPx } from "../game/unitTypes";
import { sheetForType, unitFrame, buildingDraw } from "./sprites";

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

/** Draw all units + buildings for this frame: cull dead sprites, then interpolate/animate the rest.
 *  `delta` is the frame time (ms) — drives the display catch-up cap. */
export function drawEntities(scene: Phaser.Scene, units: RenderUnit[], delta: number): void {
    const now        = Date.now();
    // Interpolation factor: 0 just after a snapshot arrives → 1 a tick later.
    // Quantized into INTERP_SUBSTEPS sub-steps for a stepped, less-floaty feel
    // (1 = snap to the latest snapshot, no interpolation).
    const raw        = Math.min(1, (performance.now() - scene.snapAt) / scene.snapInterval);
    const t          = INTERP_SUBSTEPS <= 1 ? 1 : Math.round(raw * INTERP_SUBSTEPS) / INTERP_SUBSTEPS;
    const maxCatchup = MAX_CATCHUP_PX_PER_MS * delta;   // per-frame display catch-up cap (px)
    const currentSet = new Set(units.map(u => u.uid));

    // Destroy sprites for units / buildings that no longer exist
    for (const [uid, sprite] of scene.unitSprites) {
        if (!currentSet.has(uid)) {
            sprite.destroy();
            scene.unitSprites.delete(uid);
            scene.dispPos.delete(uid);
        }
    }
    for (const [uid, sprite] of scene.buildingSprites) {
        if (!currentSet.has(uid)) {
            sprite.destroy();
            scene.buildingSprites.delete(uid);
        }
    }

    for (const u of units) {
        // Buildings render as their own sprite (separate pool, no walk cycle).
        if (u.fw > 0) { drawBuilding(scene, u); continue; }

        // Position: lerp from the previous snapshot toward this one, then ease the displayed
        // sprite toward that target at a capped speed so a one-tick settle snap glides in.
        const prev = scene.prevPos.get(u.uid);
        const tgx = (prev ? prev.x + (u.x - prev.x) * t : u.x) / FP;
        const tgy = (prev ? prev.y + (u.y - prev.y) * t : u.y) / FP;
        let disp = scene.dispPos.get(u.uid);
        if (!disp) { disp = { x: tgx, y: tgy }; scene.dispPos.set(u.uid, disp); }
        const ddx = tgx - disp.x, ddy = tgy - disp.y, dd = Math.hypot(ddx, ddy);
        if (dd > maxCatchup) { disp.x += ddx * maxCatchup / dd; disp.y += ddy * maxCatchup / dd; }
        else                 { disp.x = tgx; disp.y = tgy; }
        const px = disp.x, py = disp.y;

        // Facing/animation: a pending local prediction overrides the snapshot
        // (instant turn) until the authoritative state catches up.
        const pred   = scene.prediction.get(u.uid);
        const dir    = pred ? pred.dir : u.dir;
        const moving = pred ? true : !!u.moving;

        // ── Sprite + frame from the registry (keyed by unit type) ─────────
        // Units without sprite data fall back to the team worker sheet.
        const typeName = unitTypeName(u.type);
        let sheet = sheetForType(typeName, scene.tilesetName);
        let drawType = typeName;
        if (!sheet) { drawType = u.team === 0 ? "unit-peasant" : "unit-peon"; sheet = sheetForType(drawType, scene.tilesetName)!; }
        const key = sheet.key;
        const { frame, flipX } = unitFrame(drawType, dir, moving, now);

        let sprite = scene.unitSprites.get(u.uid);
        if (!sprite) {
            sprite = scene.add.sprite(px, py, key, frame).setDepth(0);
            scene.unitSprites.set(u.uid, sprite);
        } else {
            sprite.setPosition(px, py);
            sprite.setTexture(key, frame);
        }
        sprite.setFlipX(flipX);

        // ── Selection ring ────────────────────────────────────────────────
        if (scene.selectedUids.has(u.uid)) {
            // Box matches the unit's own collision size (32×32 ground, 64×64 ships/flyers).
            const [shw, shh] = unitBoxHalfPx(u.type);
            scene.gfx.lineStyle(1.5, SEL_COLOR, 1);
            scene.gfx.strokeRect(px - shw, py - shh, shw * 2, shh * 2);
        }

        // ── Move-target dot ────────────────────────────────────────────────
        // Predicted target shows instantly; otherwise the authoritative one.
        if (pred) {
            scene.gfx.fillStyle(0xffffff, 0.3);
            scene.gfx.fillCircle(pred.mtx / FP, pred.mty / FP, 3);
        } else if (u.mtActive) {
            scene.gfx.fillStyle(0xffffff, 0.3);
            scene.gfx.fillCircle(u.mtx / FP, u.mty / FP, 3);
        }
    }
}

/** Render a building: a staged construction-site sprite while building, then
 *  the finished building (frame 0).  Footprint selection box; coloured-rect
 *  fallback if a texture is unavailable. */
function drawBuilding(scene: Phaser.Scene, u: RenderUnit): void {
    const w = u.fw * TILE_PX, h = u.fh * TILE_PX;
    const cx = u.x / FP, cy = u.y / FP;
    const left = cx - w / 2, top = cy - h / 2;
    const typeName = unitTypeName(u.type);

    // Registry decides texture/frame/anchor from construction progress.
    const { key, frame, centered } = buildingDraw(typeName, u.buildLeft, unitBuildTicks(u.type));

    if (scene.textures.exists(key)) {
        let spr = scene.buildingSprites.get(u.uid);
        if (!spr) { spr = scene.add.sprite(0, 0, key, 0).setDepth(0); scene.buildingSprites.set(u.uid, spr); }
        const maxFrame = scene.textures.get(key).frameTotal - 2;   // exclude __BASE
        spr.setTexture(key, Math.min(frame, Math.max(0, maxFrame)));
        if (centered) spr.setOrigin(0.5, 0.5).setPosition(cx, cy);   // small site, centred on footprint
        else          spr.setOrigin(0, 0).setPosition(left, top);     // building fills footprint
    } else {
        // Texture missing — coloured footprint rect fallback.
        const color = u.team === 0 ? 0x3366cc : 0xcc3333;
        scene.gfx.fillStyle(color, u.buildLeft > 0 ? 0.35 : 0.7);
        scene.gfx.fillRect(left, top, w, h);
        scene.gfx.lineStyle(2, 0x000000, 0.8);
        scene.gfx.strokeRect(left, top, w, h);
    }

    // Selection box around the footprint
    if (scene.selectedUids.has(u.uid)) {
        scene.gfx.lineStyle(2, SEL_COLOR, 1);
        scene.gfx.strokeRect(left - 2, top - 2, w + 4, h + 4);
    }
}
