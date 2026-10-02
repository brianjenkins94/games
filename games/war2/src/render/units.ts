/**
 * Entity drawing — the per-frame loop that turns the latest view into Phaser sprites: position interpolation, sprite
 * lifecycle (spawn / reuse / destroy), facing and animation, selection rings, move-target dots, and building sprites.
 * Carried from the old war2's renderer (W3, see MIGRATION.md). Own units come from the client worker's prediction —
 * they turn and walk the moment a command is given — so the old renderer's separate prediction overlay is gone.
 */
import type { UnitInfo } from "../browser/bootstrap.ts";
import type { RendererState } from "./renderer.ts";
import type { SheetDef } from "./sprites.ts";
import { FP, TILE_PX } from "../sim/components.ts";
import { unitBoxHalfPx, unitBuildTicks, unitTypeId } from "../sim/unitTypes.ts";
import { buildingDraw, constructionSheet, sheetForType, unitFrame } from "./sprites.ts";

/** Lazily load a spritesheet the first time an entity needs it. Returns true once the texture is ready to draw.
 *  Phaser's loader runs after boot, so the sheet is queued and the loader (re)started; the texture lands a frame or
 *  two later — callers skip (units) or fall back to a rect (buildings) until then. */
function ensureSheet(renderer: RendererState, sheet: SheetDef): boolean {
	const { scene } = renderer;

	if (scene.textures.exists(sheet.key)) { return true; }
	if (!renderer.pendingSheets.has(sheet.key)) {
		renderer.pendingSheets.add(sheet.key);
		scene.load.spritesheet(sheet.key, sheet.url, { "frameWidth": sheet.frameW, "frameHeight": sheet.frameH });
		if (!scene.load.isLoading()) { scene.load.start(); }
	}

	return false;
}

// Position-interpolation cadence (feel knob): the lerp between views in N sub-steps per tick rather than continuous —
// 1 snaps to the latest view; 2–4 is a stepped, retro RTS cadence; ~30 is effectively smooth.
const INTERP_SUBSTEPS = 2;

// Cap on how fast the displayed sprite catches up to its position, px/ms: normal walking (~0.06 px/ms) keeps up
// exactly; a settle snap (movement.ts) resolves in about a frame instead of teleporting. Render-only.
const MAX_CATCHUP_PX_PER_MS = 0.25;

const SEL_COLOR = 0x00FF00;
// Building sprites sit just below the unit layer (units at depth 0), above terrain (-1).
const BUILDING_DEPTH = -0.5;

/** Draw all units and buildings for this frame: cull gone sprites, then interpolate and animate the rest. `delta` is
 *  the frame time (ms): it drives the display catch-up cap. */
export function drawEntities(renderer: RendererState, units: UnitInfo[], delta: number): void {
	const now = Date.now();
	const raw = Math.min(1, (performance.now() - renderer.snapAt) / renderer.snapInterval);
	const t = INTERP_SUBSTEPS <= 1 ? 1 : Math.round(raw * INTERP_SUBSTEPS) / INTERP_SUBSTEPS;
	const maxCatchup = MAX_CATCHUP_PX_PER_MS * delta;
	const current = new Set(units.map((u) => u.uid));

	for (const [uid, sprite] of renderer.unitSprites) {
		if (!current.has(uid)) {
			sprite.destroy();
			renderer.unitSprites.delete(uid);
			renderer.dispPos.delete(uid);
		}
	}

	for (const [uid, sprite] of renderer.buildingSprites) {
		if (!current.has(uid)) {
			sprite.destroy();
			renderer.buildingSprites.delete(uid);
		}
	}

	for (const u of units) {
		if (u.building !== undefined) { drawBuilding(renderer, u); continue; }

		// Lerp from the previous view toward this one, then ease the displayed sprite toward that at a capped speed.
		const prev = renderer.prevPos.get(u.uid);
		const tgx = (prev ? prev.x + (u.x - prev.x) * t : u.x) / FP;
		const tgy = (prev ? prev.y + (u.y - prev.y) * t : u.y) / FP;
		let disp = renderer.dispPos.get(u.uid);

		if (!disp) { disp = { "x": tgx, "y": tgy }; renderer.dispPos.set(u.uid, disp); }
		const ddx = tgx - disp.x; const ddy = tgy - disp.y; const
			dd = Math.hypot(ddx, ddy);

		if (dd > maxCatchup) { disp.x += ddx * maxCatchup / dd; disp.y += ddy * maxCatchup / dd; } else { disp.x = tgx; disp.y = tgy; }

		// Sprite and frame from the registry (by unit type); a type without art falls back to its team's worker.
		let drawType = u.type;
		let sheet = sheetForType(drawType, renderer.tileset);

		if (!sheet) { drawType = u.team % 2 === 0 ? "unit-peasant" : "unit-peon"; sheet = sheetForType(drawType, renderer.tileset)!; }
		const { frame, flipX } = unitFrame(drawType, u.dir, u.moving, now);

		if (!ensureSheet(renderer, sheet)) { continue; }

		let sprite = renderer.unitSprites.get(u.uid);

		if (!sprite) {
			sprite = renderer.scene.add.sprite(disp.x, disp.y, sheet.key, frame).setDepth(0);
			renderer.unitSprites.set(u.uid, sprite);
		} else {
			sprite.setPosition(disp.x, disp.y);
			sprite.setTexture(sheet.key, frame);
		}

		sprite.setFlipX(flipX);

		// Selection box: the unit's own collision size (32×32 ground, 64×64 ships and flyers).
		if (renderer.selected.has(u.uid)) {
			const [shw, shh] = unitBoxHalfPx(unitTypeId(u.type));

			renderer.gfx.lineStyle(1.5, SEL_COLOR, 1);
			renderer.gfx.strokeRect(disp.x - shw, disp.y - shh, shw * 2, shh * 2);
		}

		if (u.target !== undefined && u.team === renderer.team) {
			renderer.gfx.fillStyle(0xFFFFFF, 0.3);
			renderer.gfx.fillCircle(u.target[0] / FP, u.target[1] / FP, 3);
		}
	}
}

/** Render a building: a staged construction-site sprite while building, then the finished building (frame 0);
 *  a footprint selection box; a coloured rect until (or if) its texture is unavailable. */
function drawBuilding(renderer: RendererState, u: UnitInfo): void {
	const { w: fw, h: fh, buildLeft } = u.building!;
	const w = fw * TILE_PX; const
		h = fh * TILE_PX;
	const cx = u.x / FP; const
		cy = u.y / FP;
	const left = cx - w / 2; const
		top = cy - h / 2;
	const { key, frame, centered } = buildingDraw(u.type, buildLeft, unitBuildTicks(unitTypeId(u.type)));
	const sheet = key.startsWith("con:") ? constructionSheet(key.slice(4), renderer.tileset) : sheetForType(u.type, renderer.tileset);

	if (sheet) { ensureSheet(renderer, sheet); }

	if (renderer.scene.textures.exists(key)) {
		let sprite = renderer.buildingSprites.get(u.uid);

		if (!sprite) { sprite = renderer.scene.add.sprite(0, 0, key, 0).setDepth(BUILDING_DEPTH); renderer.buildingSprites.set(u.uid, sprite); }
		const maxFrame = renderer.scene.textures.get(key).frameTotal - 2;   // exclude __BASE

		sprite.setTexture(key, Math.min(frame, Math.max(0, maxFrame)));
		if (centered) { sprite.setOrigin(0.5, 0.5).setPosition(cx, cy); } else { sprite.setOrigin(0, 0).setPosition(left, top); }
	} else {
		renderer.gfx.fillStyle(u.team === renderer.team ? 0x3366CC : 0xCC3333, buildLeft > 0 ? 0.35 : 0.7);
		renderer.gfx.fillRect(left, top, w, h);
		renderer.gfx.lineStyle(2, 0x000000, 0.8);
		renderer.gfx.strokeRect(left, top, w, h);
	}

	if (renderer.selected.has(u.uid)) {
		renderer.gfx.lineStyle(2, SEL_COLOR, 1);
		renderer.gfx.strokeRect(left - 2, top - 2, w + 4, h + 4);
	}
}
