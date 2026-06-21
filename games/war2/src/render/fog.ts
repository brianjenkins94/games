/**
 * Fog of war — recompute per-tile visibility for the viewing team each frame and push it to the
 * ChunkRenderer (which dims/blacks terrain accordingly).  Split out of renderer.ts.
 *
 * The visibility metric (dodecagonal `inRange`) is the single source of truth shared with the sim
 * (vision.ts isTileVisible / computeVisibleUids), so the drawn fog matches actual gameplay vision.
 */
import Phaser from "phaser";
import { FP, TILE_PX } from "../game/components";
import { inRange } from "../game/distance";
import { unitSight } from "../game/unitTypes";
import type { RenderUnit } from "../worker/ipc";

/**
 * Recompute per-tile visibility for `scene.myTeam` and push it to the ChunkRenderer.
 *
 * tileVis values:
 *   0 = UNEXPLORED — never seen; solid ~100% black
 *   1 = EXPLORED   — seen before but not current view; 50% dim terrain
 *   2 = VISIBLE    — currently in sight; full terrain + fog edge tiles
 */
export function updateFow(scene: Phaser.Scene, units: RenderUnit[]): void {
    if (!scene.chunkRenderer || !scene.tileVis || !scene.tileExplored) return;

    const mapW = scene.mapTileW;
    const mapH = scene.mapTileH;
    const vis  = scene.tileVis;
    const exp  = scene.tileExplored;

    // Start from explored state, then mark current visibility on top
    for (let i = 0; i < vis.length; i++) vis[i] = exp[i];

    // Mark tiles currently in sight of any own unit as VISIBLE (2)
    for (const u of units) {
        if (u.team !== scene.myTeam) continue;
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
                // Dodecagonal metric — shared with the sim so the drawn fog is identical at any radius.
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

    scene.chunkRenderer.updateFog(vis, mapW, mapH);
}
