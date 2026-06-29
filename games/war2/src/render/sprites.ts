/**
 * Sprite registry — the single, data-driven source of truth for entity graphics.
 *
 * One Vite glob resolves every graphic to a URL; geometry and animation come
 * straight from the asset JSON (no dimensions or frame sequences are hardcoded):
 *   • mobile units  → sprites.json  (file, frameWidth/Height, numDirections,
 *                     animations: Still/Move/Attack/Death/… with per-frame durations)
 *   • buildings     → units.json `files` (per tileset) + `tileSize` (footprint)
 *   • construction  → constructions.json (files + size + staged frames)
 *
 * Sheets are looked up *by unit type* (never by team).  Adding a unit = a
 * sprites.json entry; adding a building = a units.json `files` map.  Render-only:
 * nothing here touches the sim or affects determinism.
 *
 * Texture keys:  unit → "unit:<type>", building → "bld:<type>",
 *                construction site → "con:<construction-type>".
 */
import unitsJson from "../assets/units.json";
import spritesJson from "../assets/sprites.json";
import constructionsJson from "../assets/constructions.json";
import { TILE_PX } from "../game/components";

// Every PNG under graphics/, resolved to a URL.  Eager + ?url is cheap (URL
// strings only — image bytes load lazily when a texture uses one).
const ASSET_URLS = import.meta.glob(
    "../assets/graphics/**/*.png",
    { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

const url = (rel?: string): string | undefined =>
    rel ? ASSET_URLS["../assets/graphics/" + rel] : undefined;

const UNITS   = unitsJson as Record<string, any>;
const SPRITES = spritesJson as Record<string, any>;
const CONS    = constructionsJson as Record<string, any>;

export interface SheetDef { key: string; url: string; frameW: number; frameH: number; }

// ── Animation (mobile units) ──────────────────────────────────────────────────
// Each animation is a list of { frame, duration }; `duration` is in animation
// ticks.  We advance through the looping sequence by wall-clock time.

const ANIM_TICK_MS = 50;   // ms per duration unit (tunable feel knob)

interface AnimStep { frame: number; duration: number }

/** Base frame for an animation sequence at time `now` (looping). */
function animBaseFrame(seq: AnimStep[] | undefined, now: number): number {
    if (!seq || !seq.length) return 0;
    let total = 0;
    for (const s of seq) total += s.duration;
    if (total <= 0) return seq[0].frame;
    let t = Math.floor(now / ANIM_TICK_MS) % total;
    for (const s of seq) { if (t < s.duration) return s.frame; t -= s.duration; }
    return seq[0].frame;
}

/** Frame + flip for a mobile unit: animation base frame + direction column.
 *  Directions ≥ numDirections mirror their lower counterpart (flipX). */
export function unitFrame(typeName: string, dir: number, moving: boolean, now: number): { frame: number; flipX: boolean } {
    const def = SPRITES[typeName];
    if (!def) return { frame: 0, flipX: false };
    const nd   = def.numDirections ?? 5;
    const base = animBaseFrame(def.animations?.[moving ? "Move" : "Still"], now);
    const col  = dir < nd ? dir : 2 * (nd - 1) - dir;
    return { frame: base + col, flipX: dir >= nd };
}

// ── Construction frame layout ─────────────────────────────────────────────────

type ConStage = { percent: number; file: string; frame: number };

function pickStage(stages: ConStage[], percent: number): ConStage {
    let chosen = stages[0];
    for (const s of stages) if (s.percent <= percent) chosen = s;
    return chosen;
}

/** Which construction site a building uses (walls have their own; rest use land;
 *  naval/advanced sites are deferred and fall through to land). */
function constructionTypeFor(typeName: string): string {
    return typeName.includes("-wall") ? "construction-wall" : "construction-land";
}

// ── Sheet resolution ──────────────────────────────────────────────────────────

/** Spritesheet for a unit type — building (units.json) or mobile unit (sprites.json). */
export function sheetForType(typeName: string, tileset: string): SheetDef | undefined {
    if (UNITS[typeName]?.building) {
        const def = UNITS[typeName];
        const u = url(def.files?.[tileset] ?? def.files?.summer);
        if (!u) return undefined;
        const [tw, th] = (def.tileSize ?? [1, 1]) as [number, number];
        return { key: "bld:" + typeName, url: u, frameW: tw * TILE_PX, frameH: th * TILE_PX };
    }
    const sp = SPRITES[typeName];
    const u = url(sp?.file);
    if (!u) return undefined;
    return { key: "unit:" + typeName, url: u, frameW: sp.frameWidth, frameH: sp.frameHeight };
}

/** Construction-site spritesheet for a construction type + tileset. */
export function constructionSheet(conType: string, tileset: string): SheetDef | undefined {
    const def = CONS[conType];
    const u = url(def?.files?.[tileset] ?? def?.files?.summer);
    if (!u) return undefined;
    const [cw, ch] = def.size as [number, number];
    return { key: "con:" + conType, url: u, frameW: cw, frameH: ch };
}

// ── Building draw resolution (construction staging) ───────────────────────────

export interface BuildingDraw { key: string; frame: number; centered: boolean; }

/** Texture/frame/anchor for a building given construction progress.  centered =
 *  small construction site on the footprint centre; else the building fills it. */
export function buildingDraw(typeName: string, buildLeft: number, buildTotal: number): BuildingDraw {
    if (buildLeft > 0) {
        const percent = buildTotal > 0 ? ((buildTotal - buildLeft) / buildTotal) * 100 : 100;
        const conType = constructionTypeFor(typeName);
        const stages  = CONS[conType]?.stages as ConStage[] | undefined;
        const stage   = stages?.length ? pickStage(stages, percent) : undefined;
        if (stage?.file === "construction") return { key: "con:" + conType, frame: stage.frame, centered: true };
        if (stage)                          return { key: "bld:" + typeName, frame: stage.frame, centered: false };
    }
    return { key: "bld:" + typeName, frame: 0, centered: false };
}
