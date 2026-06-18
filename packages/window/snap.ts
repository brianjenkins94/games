/**
 * Window snapping for VtWindow — magnetic edges + edge tiling (Aero-snap).
 *
 * Pure geometry plus one shared preview overlay; no dependencies beyond the theme palette.
 * The Drag helper calls into it:
 *   • magnetism (`snapMove`/`snapResize`) nudges the live geometry each move/resize so a
 *     window's edges stick to the viewport and to peer windows within MAGNET px;
 *   • tiling (`tileZone`) shows a translucent preview while the cursor sits against a
 *     viewport edge/corner and is committed on release (`applyRect`), with the pre-tile rect
 *     remembered (`setTiled`) so grabbing the window again pops it back to its floating size.
 *
 * All coordinates are viewport-relative (windows are position:fixed), matching style.left/top.
 */
import { palette } from "theme";

export interface Rect { l: number; t: number; w: number; h: number; }

const MAGNET = 8;    // px: edges within this distance snap together
const EDGE = 28;     // px: cursor within this of a viewport edge arms a tile zone
const SEL = ".vt-window";

// ── Tiled-state memory (so a tiled window restores its floating size when dragged off) ──
const tiled = new WeakMap<HTMLElement, Rect>();
export const isTiled  = (el: HTMLElement): boolean => tiled.has(el);
export const setTiled = (el: HTMLElement, pre: Rect): void => { tiled.set(el, pre); };
export const popTiled = (el: HTMLElement): Rect | undefined => {
    const r = tiled.get(el); tiled.delete(el); return r;
};

/** Visible peer windows' rects (excludes self, the minimized strip, and hidden ones). */
export function peerRects(self: HTMLElement): Rect[] {
    const out: Rect[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(SEL)) {
        if (el === self) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;   // skip minimized strip / hidden
        out.push({ l: r.left, t: r.top, w: r.width, h: r.height });
    }
    return out;
}

/** Snap a value to the nearest candidate within MAGNET; else return it unchanged. */
function magnet(v: number, candidates: number[]): number {
    let best = v, bestD = MAGNET + 1;
    for (const c of candidates) {
        const d = Math.abs(v - c);
        if (d <= MAGNET && d < bestD) { best = c; bestD = d; }
    }
    return best;
}

/** Magnetic alignment for a moving window — nudge left/top so its edges meet peers/viewport. */
export function snapMove(l: number, t: number, w: number, h: number, peers: Rect[], vw: number, vh: number): { l: number; t: number } {
    const xs = [0, vw - w], ys = [0, vh - h];
    for (const p of peers) {
        xs.push(p.l, p.l + p.w - w, p.l + p.w, p.l - w);   // align L–L, R–R, L–R, R–L
        ys.push(p.t, p.t + p.h - h, p.t + p.h, p.t - h);
    }
    return { l: magnet(l, xs), t: magnet(t, ys) };
}

/** Magnetic alignment for a resize (top-left fixed) — nudge width/height to meet edges. */
export function snapResize(l: number, t: number, w: number, h: number, peers: Rect[], vw: number, vh: number): { w: number; h: number } {
    const rs = [vw - l], bs = [vh - t];                    // right/bottom edge → viewport
    for (const p of peers) { rs.push(p.l - l, p.l + p.w - l); bs.push(p.t - t, p.t + p.h - t); }
    return { w: magnet(w, rs), h: magnet(h, bs) };
}

/** Tile target for a cursor near a viewport edge/corner, else null (top → fill, sides → halves). */
export function tileZone(cx: number, cy: number, vw: number, vh: number): Rect | null {
    const L = cx <= EDGE, R = cx >= vw - EDGE, T = cy <= EDGE, B = cy >= vh - EDGE;
    const hw = Math.round(vw / 2), hh = Math.round(vh / 2);
    if (T && L) return { l: 0,  t: 0,  w: hw,      h: hh };
    if (T && R) return { l: hw, t: 0,  w: vw - hw, h: hh };
    if (B && L) return { l: 0,  t: hh, w: hw,      h: vh - hh };
    if (B && R) return { l: hw, t: hh, w: vw - hw, h: vh - hh };
    if (T)      return { l: 0,  t: 0,  w: vw,      h: vh };       // top → fill
    if (L)      return { l: 0,  t: 0,  w: hw,      h: vh };       // left half
    if (R)      return { l: hw, t: 0,  w: vw - hw, h: vh };       // right half
    return null;
}

/** Apply a rect to a window's inline geometry (committing a tile). */
export function applyRect(el: HTMLElement, r: Rect): void {
    el.style.left = `${r.l}px`; el.style.top = `${r.t}px`;
    el.style.width = `${r.w}px`; el.style.height = `${r.h}px`;
}

// ── Preview overlay (single shared element) ───────────────────────────────────────
let preview: HTMLDivElement | null = null;
export function showPreview(r: Rect): void {
    if (!preview) {
        preview = document.createElement("div");
        preview.style.cssText =
            "position:fixed;z-index:9998;pointer-events:none;border-radius:4px;" +
            `background:${palette.accent}33;border:2px solid ${palette.accent};` +
            "transition:left .08s,top .08s,width .08s,height .08s;";
        document.body.appendChild(preview);
    }
    preview.style.display = "block";
    preview.style.left = `${r.l}px`; preview.style.top = `${r.t}px`;
    preview.style.width = `${r.w}px`; preview.style.height = `${r.h}px`;
}
export function hidePreview(): void { if (preview) preview.style.display = "none"; }
