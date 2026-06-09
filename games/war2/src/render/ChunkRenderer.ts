/**
 * ChunkRenderer — streams map tiles as 16×16-tile RenderTexture chunks.
 *
 * Memory model:
 *   - Tile GIDs live in a flat number[] in JS heap.
 *   - Each loaded chunk has a terrain RenderTexture (baked once, static) and a
 *     fog RenderTexture (rebuilt whenever any tile visibility in or around the
 *     chunk changes).
 *   - Only chunks within BUFFER chunks of the camera are kept alive.
 *
 * Fog of war (tile-level):
 *   Each tile carries one of three states:
 *     0 = UNEXPLORED  — never seen; solid ~100% black
 *     1 = EXPLORED    — seen before but not current view; 50% dim terrain
 *     2 = VISIBLE     — currently in sight; full terrain
 *
 *   The fog edge graphics come from the tileset's first 16 tile frames (GIDs 0-15),
 *   indexed via the WC2/Stratagus TiledFogTable.  Two passes are composited:
 *
 *     blackEdge  — drawn on any tile whose neighbours include UNEXPLORED tiles.
 *                  Alpha ≈ 100%.  Creates the smooth black curve at the
 *                  explored/unexplored boundary.
 *     dimEdge    — drawn on VISIBLE tiles whose neighbours include non-visible
 *                  (explored or unexplored) tiles.  Alpha ≈ 50%.  Creates the
 *                  smooth dim curve at the visible/explored boundary.
 *
 *   Bit contributions to the 4-bit index (bit is set when that neighbour is
 *   "in fog" — i.e. below the relevant threshold):
 *
 *     NW→2  N→3  NE→1
 *     W→10  *    E→5
 *     SW→8  S→12 SE→4
 *
 *   Source: Stratagus src/map/fow.cpp :: GetFogTile / TiledFogTable
 */

import Phaser from "phaser";

export const CHUNK_TILES = 16;
export const TILE_PX     = 32;
export const CHUNK_PX    = CHUNK_TILES * TILE_PX;   // 512

const BUFFER = 1;

/**
 * WC2 fog lookup table (from Stratagus TiledFogTable).
 * Input: 4-bit neighbour bitmask.  Output: fog tile frame index, or 0 = no tile.
 */
const FOG_TILE_TABLE = [0, 11, 10, 2, 13, 6, 14, 3, 12, 15, 4, 1, 8, 9, 7, 0] as const;

/**
 * Opacity values from wargus/scripts/stratagus.lua:
 *   SetFogOfWarOpacityLevels(0x7F, 0xBE, 0xFE)
 *   explored=0x7F (≈50%), revealed=0xBE, unseen=0xFE (≈100%)
 */
const FOG_DIM_ALPHA   = 0x7F / 255;   // explored tiles  (Stratagus ExploredOpacity)
const FOG_BLACK_ALPHA = 0xFE / 255;   // unexplored/edge (Stratagus UnseenOpacity)

/**
 * [dx, dy, bitsToOR] for the 8 surrounding tiles.
 * Matches the bit contributions in Stratagus fow.cpp :: GetFogTile.
 * Note: the table is indexed by the COMPLEMENT of our computed bitmask —
 * GetFogTile ORs bits when a neighbour IS visible, but fogIndex ORs when
 * a neighbour IS in fog.  The lookup therefore uses (~idx) & 15.
 */
/**
 * Bit contributions from Stratagus fow.cpp :: GetFogTile.
 * The table is indexed by the complement (~idx)&15 because GetFogTile ORs
 * bits when a neighbour IS visible, but fogIndex ORs when it IS in fog.
 */
/**
 * Stratagus fow.cpp :: GetFogTile bit contributions.
 * Table is indexed by (~idx)&15.
 */
/** Stratagus fow.cpp :: GetFogTile bit contributions. Table indexed by (~idx)&15. */
const FOG_NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
    [-1, -1,  2],   // NW
    [ 0, -1,  3],   // N
    [ 1, -1,  1],   // NE
    [-1,  0, 10],   // W
    [ 1,  0,  5],   // E
    [-1,  1,  8],   // SW
    [ 0,  1, 12],   // S
    [ 1,  1,  4],   // SE
];

interface Chunk {
    rt:      Phaser.GameObjects.RenderTexture;  // terrain (static)
    fogRT:   Phaser.GameObjects.RenderTexture;  // fog overlay (rebuilt on change)
    fogHash: number;                             // hash of tileVis used for last build
}

export class ChunkRenderer {
    private readonly scene:      Phaser.Scene;
    private readonly gids:       number[];
    private readonly mapW:       number;
    private readonly mapH:       number;
    private readonly tilesetKey: string;

    private readonly chunks = new Map<string, Chunk>();

    constructor(
        scene:      Phaser.Scene,
        gids:       number[],
        mapW:       number,
        mapH:       number,
        tilesetKey: string,
    ) {
        this.scene      = scene;
        this.gids       = gids;
        this.mapW       = mapW;
        this.mapH       = mapH;
        this.tilesetKey = tilesetKey;
        this.ensureFogSolidTexture();
    }

    // ── Per-frame update ──────────────────────────────────────────────────────

    update(cam: Phaser.Cameras.Scene2D.Camera): void {
        const chunksX = Math.ceil(this.mapW / CHUNK_TILES);
        const chunksY = Math.ceil(this.mapH / CHUNK_TILES);

        const cx0 = Math.max(0, Math.floor(cam.scrollX / CHUNK_PX) - BUFFER);
        const cy0 = Math.max(0, Math.floor(cam.scrollY / CHUNK_PX) - BUFFER);
        const cx1 = Math.min(chunksX - 1, Math.floor((cam.scrollX + cam.width)  / CHUNK_PX) + BUFFER);
        const cy1 = Math.min(chunksY - 1, Math.floor((cam.scrollY + cam.height) / CHUNK_PX) + BUFFER);

        const desired = new Set<string>();
        for (let cy = cy0; cy <= cy1; cy++)
            for (let cx = cx0; cx <= cx1; cx++)
                desired.add(`${cx},${cy}`);

        for (const key of desired)
            if (!this.chunks.has(key)) {
                const [cx, cy] = key.split(',').map(Number);
                this.loadChunk(cx, cy);
            }

        for (const key of this.chunks.keys())
            if (!desired.has(key))
                this.unloadChunk(key);
    }

    /**
     * Rebuild fog RTs for any loaded chunk whose visibility changed.
     * Called by the renderer once per frame after computing per-tile visibility.
     *
     * tileVis: flat Uint8Array, mapW × mapH.  Values: 0=UNEXPLORED, 1=EXPLORED, 2=VISIBLE.
     */
    updateFog(tileVis: Uint8Array, mapW: number, mapH: number): void {
        for (const [key, chunk] of this.chunks) {
            const [cx, cy] = key.split(',').map(Number);
            const hash = this.chunkFogHash(cx, cy, tileVis, mapW, mapH);
            if (hash !== chunk.fogHash) {
                chunk.fogHash = hash;
                this.buildFogRT(chunk, cx, cy, tileVis, mapW, mapH);
            }
        }
    }

    destroy(): void {
        for (const key of [...this.chunks.keys()]) this.unloadChunk(key);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /** Create a 32×32 solid black texture used for dim/black fog base fills. */
    private ensureFogSolidTexture(): void {
        if (this.scene.textures.exists('fogSolid')) return;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = TILE_PX;
        const ctx    = canvas.getContext('2d')!;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, TILE_PX, TILE_PX);
        this.scene.textures.addCanvas('fogSolid', canvas);
    }


    private loadChunk(cx: number, cy: number): void {
        const key    = `${cx},${cy}`;
        const worldX = cx * CHUNK_PX;
        const worldY = cy * CHUNK_PX;

        // ── Terrain RT (baked once, static) ──────────────────────────────────
        const rt     = this.scene.add
            .renderTexture(worldX, worldY, CHUNK_PX, CHUNK_PX)
            .setOrigin(0, 0)
            .setDepth(-1);
        const origin = { originX: 0, originY: 0 };
        for (let ty = 0; ty < CHUNK_TILES; ty++) {
            const mapY = cy * CHUNK_TILES + ty;
            if (mapY >= this.mapH) continue;
            for (let tx = 0; tx < CHUNK_TILES; tx++) {
                const mapX = cx * CHUNK_TILES + tx;
                if (mapX >= this.mapW) continue;
                const gid = this.gids[mapY * this.mapW + mapX];
                if (gid < 1) continue;
                rt.stamp(this.tilesetKey, gid - 1, tx * TILE_PX, ty * TILE_PX, origin);
            }
        }
        rt.render();

        // ── Fog RT (rebuilt dynamically) ──────────────────────────────────────
        // Default: fully black (UNEXPLORED).  Will be updated by updateFog().
        const fogRT  = this.scene.add
            .renderTexture(worldX, worldY, CHUNK_PX, CHUNK_PX)
            .setOrigin(0, 0)
            .setDepth(1);
        const black  = { originX: 0, originY: 0, alpha: FOG_BLACK_ALPHA };
        for (let ty = 0; ty < CHUNK_TILES; ty++)
            for (let tx = 0; tx < CHUNK_TILES; tx++)
                fogRT.stamp('fogSolid', 0, tx * TILE_PX, ty * TILE_PX, black);
        fogRT.render();

        this.chunks.set(key, { rt, fogRT, fogHash: -1 });
    }

    private unloadChunk(key: string): void {
        const chunk = this.chunks.get(key);
        if (!chunk) return;
        chunk.rt.destroy();
        chunk.fogRT.destroy();
        this.chunks.delete(key);
    }

    /**
     * Hash over the tileVis values for a chunk + its 1-tile border.
     * The border is included so that edge-tile computation in adjacent chunks
     * also triggers a rebuild when tiles on this chunk's perimeter change.
     */
    private chunkFogHash(cx: number, cy: number, tileVis: Uint8Array, mapW: number, mapH: number): number {
        let h = (cx * 1_000_003 ^ cy * 997) | 0;
        const tx0 = Math.max(0, cx * CHUNK_TILES - 1);
        const ty0 = Math.max(0, cy * CHUNK_TILES - 1);
        const tx1 = Math.min(mapW - 1, (cx + 1) * CHUNK_TILES);
        const ty1 = Math.min(mapH - 1, (cy + 1) * CHUNK_TILES);
        for (let ty = ty0; ty <= ty1; ty++)
            for (let tx = tx0; tx <= tx1; tx++)
                h = (Math.imul(h, 31) + tileVis[ty * mapW + tx]) | 0;
        return h;
    }

    /**
     * Build the 4-bit fog index for tile (tx, ty).
     * A neighbour contributes its bit(s) when its visibility < threshold.
     *   threshold = 1: only UNEXPLORED (0) neighbours contribute  → blackEdge index
     *   threshold = 2: UNEXPLORED + EXPLORED (0,1) contribute     → dimEdge index
     */
    private fogIndex(
        tx: number, ty: number,
        tileVis: Uint8Array, mapW: number, mapH: number,
        threshold: number,
    ): number {
        let idx = 0;
        for (const [dx, dy, bits] of FOG_NEIGHBOURS) {
            const nx = tx + dx, ny = ty + dy;
            if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) continue;
            if (tileVis[ny * mapW + nx] < threshold) idx |= bits;
        }
        return idx;
    }

    /**
     * Rebuild the fog RenderTexture for a chunk from scratch.
     *
     * Three layers composited in order:
     *   1. Solid base fill  (black at ~100% for UNEXPLORED, ~50% for EXPLORED)
     *   2. Black edge tiles (FOG_BLACK_ALPHA) near UNEXPLORED neighbours
     *   3. Dim edge tiles   (FOG_DIM_ALPHA)   on VISIBLE tiles near non-visible neighbours
     */
    private buildFogRT(
        chunk: Chunk,
        cx: number, cy: number,
        tileVis: Uint8Array, mapW: number, mapH: number,
    ): void {
        const fogRT = chunk.fogRT;

        // Separate config objects — never mutate a config used by a different pass
        const solidBlack = { originX: 0, originY: 0, alpha: FOG_BLACK_ALPHA };
        const solidDim   = { originX: 0, originY: 0, alpha: FOG_DIM_ALPHA   };
        const edgeBlack  = { originX: 0, originY: 0, alpha: FOG_BLACK_ALPHA };
        const edgeDim    = { originX: 0, originY: 0, alpha: FOG_DIM_ALPHA   };

        fogRT.clear();

        // Pass 1 — solid base fills (unexplored = ~100% black, explored = ~50% dim)
        for (let lty = 0; lty < CHUNK_TILES; lty++) {
            const ty = cy * CHUNK_TILES + lty;
            if (ty >= mapH) continue;
            for (let ltx = 0; ltx < CHUNK_TILES; ltx++) {
                const tx    = cx * CHUNK_TILES + ltx;
                if (tx >= mapW) continue;
                const state = tileVis[ty * mapW + tx];
                if (state === 2) continue;  // VISIBLE — no fill
                fogRT.stamp('fogSolid', 0, ltx * TILE_PX, lty * TILE_PX,
                             state === 0 ? solidBlack : solidDim);
            }
        }

        // Pass 2 — fog edge tiles (frames 0-15 of the tileset, transparency baked into PNG)
        for (let lty = 0; lty < CHUNK_TILES; lty++) {
            const ty = cy * CHUNK_TILES + lty;
            if (ty >= mapH) continue;
            for (let ltx = 0; ltx < CHUNK_TILES; ltx++) {
                const tx    = cx * CHUNK_TILES + ltx;
                if (tx >= mapW) continue;
                const state = tileVis[ty * mapW + tx];
                const px = ltx * TILE_PX, py = lty * TILE_PX;

                // Black edge near unexplored neighbours — drawn on ALL tiles so
                // the scallop shapes appear on the visible boundary too.
                const bIdx  = this.fogIndex(tx, ty, tileVis, mapW, mapH, 1);
                const bTile = FOG_TILE_TABLE[bIdx];
                if (bTile !== 0) {
                    fogRT.stamp(this.tilesetKey, bTile, px, py, edgeBlack);
                }

                // Dim edge on visible tiles only, when it differs from the black edge.
                if (state === 2) {
                    const dIdx  = this.fogIndex(tx, ty, tileVis, mapW, mapH, 2);
                    const dTile = FOG_TILE_TABLE[dIdx];
                    if (dTile !== 0 && dTile !== bTile) {
                        fogRT.stamp(this.tilesetKey, dTile, px, py, edgeDim);
                    }
                }
            }
        }

        fogRT.render();
    }
}
