/** @jsxImportSource preact */
/**
 * VtWindow — a draggable / resizable / minimizable floating window, authored as a
 * conventional Preact component.  Detachable into a real browser popup.
 *
 * Lineage: a TS+Preact rewrite of Victor N.'s VtWindow (Apache-2.0,
 * https://github.com/victornpb/VtWindow).
 *
 * Design notes (why it's a hybrid of declarative + imperative):
 *   • Geometry (top/left/width/height) is owned imperatively by the Drag helper,
 *     which writes inline styles directly.  So the component NEVER passes a `style`
 *     prop on the root — Preact would clobber those inline styles on re-render.
 *     Preact only manages the class state (minimized / maximized / focus / windowed).
 *   • `body` (e.g. a netcode box's <iframe>) is appended once in a layout effect, so
 *     it's outside reconciliation and never recreated — re-creating an iframe reloads
 *     it (and drops its P2P connection).  `minimized` toggles a CSS class, it does not
 *     unmount the body.
 *   • Detach moves the whole Preact mount container into the popup (preserving the
 *     container node, so re-renders keep working).  Re-parenting the iframe across
 *     documents still reloads it — fine for a fresh debug view, not for live state.
 */
import { useRef, useState, useLayoutEffect, useEffect } from "preact/hooks";
import type { VNode } from "preact";
import { css } from "theme";

// ── Drag: make an element draggable or resizable by a handle ───────────────────

interface DragOptions {
    mode: "move" | "resize";
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight: number;
    xAxis: boolean;
    yAxis: boolean;
    draggingClass: string;
    useMouseEvents: boolean;
    useTouchEvents: boolean;
}

class Drag {
    xAxis: boolean;
    yAxis: boolean;
    private options: DragOptions;
    private _targetElm: HTMLElement;
    private _handleElm: HTMLElement;
    private _start: (e: MouseEvent | TouchEvent) => void;
    private _move: (e: MouseEvent | TouchEvent) => void;
    private _end: (e?: MouseEvent | TouchEvent) => void;

    constructor(targetElm: HTMLElement, handleElm: HTMLElement, options?: Partial<DragOptions>) {
        this.options = Object.assign({
            mode: "move", minWidth: 200, maxWidth: Infinity, minHeight: 100, maxHeight: Infinity,
            xAxis: true, yAxis: true, draggingClass: "drag", useMouseEvents: true, useTouchEvents: true,
        }, options) as DragOptions;
        this.xAxis = this.options.xAxis;
        this.yAxis = this.options.yAxis;
        this._targetElm = targetElm;
        this._handleElm = handleElm;

        let offTop = 0, offLeft = 0, offBottom = 0, offRight = 0;
        let vw = window.innerWidth, vh = window.innerHeight;
        const { minWidth, maxWidth, minHeight, maxHeight } = this.options;

        const moveOp = (x: number, y: number): void => {
            let l = x - offLeft;
            if (x - offLeft < 0) l = 0;
            else if (x - offRight > vw) l = vw - this._targetElm.clientWidth;
            let t = y - offTop;
            if (y - offTop < 0) t = 0;
            else if (y - offBottom > vh) t = vh - this._targetElm.clientHeight;
            if (this.xAxis) this._targetElm.style.left = `${l}px`;
            if (this.yAxis) this._targetElm.style.top = `${t}px`;
        };
        const resizeOp = (x: number, y: number): void => {
            let w = x - this._targetElm.offsetLeft - offRight;
            if (x - offRight > vw) w = Math.min(vw - this._targetElm.offsetLeft, maxWidth);
            else if (x - offRight - this._targetElm.offsetLeft > maxWidth) w = maxWidth;
            else if (x - offRight - this._targetElm.offsetLeft < minWidth) w = minWidth;
            let h = y - this._targetElm.offsetTop - offBottom;
            if (y - offBottom > vh) h = Math.min(vh - this._targetElm.offsetTop, maxHeight);
            else if (y - offBottom - this._targetElm.offsetTop > maxHeight) h = maxHeight;
            else if (y - offBottom - this._targetElm.offsetTop < minHeight) h = minHeight;
            if (this.xAxis) this._targetElm.style.width = `${w}px`;
            if (this.yAxis) this._targetElm.style.height = `${h}px`;
        };
        const op = this.options.mode === "move" ? moveOp : resizeOp;

        this._start = (e) => {
            const touch = e.type === "touchstart";
            const me = e as MouseEvent;
            if (!((me.buttons === 1 || me.which === 1) || touch)) return;
            e.preventDefault();
            const p = touch ? (e as TouchEvent).touches[0] : me;
            const r = this._targetElm.getBoundingClientRect();
            offTop = p.clientY - r.y; offLeft = p.clientX - r.x;
            offBottom = p.clientY - (r.y + r.height); offRight = p.clientX - (r.x + r.width);
            vw = window.innerWidth; vh = window.innerHeight;
            if (this.options.useMouseEvents) {
                document.addEventListener("mousemove", this._move);
                document.addEventListener("mouseup", this._end);
            }
            if (this.options.useTouchEvents) {
                document.addEventListener("touchmove", this._move, { passive: false });
                document.addEventListener("touchend", this._end);
            }
            this._targetElm.classList.add(this.options.draggingClass);
        };
        this._move = (e) => {
            e.preventDefault();
            let x: number, y: number;
            if (e.type === "touchmove") { const t = (e as TouchEvent).touches[0]; x = t.clientX; y = t.clientY; }
            else {
                const me = e as MouseEvent;
                if ((me.buttons || me.which) !== 1) { this._end(); return; }
                x = me.clientX; y = me.clientY;
            }
            op(x, y);
        };
        this._end = () => {
            if (this.options.useMouseEvents) {
                document.removeEventListener("mousemove", this._move);
                document.removeEventListener("mouseup", this._end);
            }
            if (this.options.useTouchEvents) {
                document.removeEventListener("touchmove", this._move);
                document.removeEventListener("touchend", this._end);
            }
            this._targetElm.classList.remove(this.options.draggingClass);
        };
        this.enable();
    }

    enable(): void {
        if (this.options.useMouseEvents) this._handleElm.addEventListener("mousedown", this._start);
        if (this.options.useTouchEvents) this._handleElm.addEventListener("touchstart", this._start, { passive: false });
    }
    destroy(): void {
        this._targetElm.classList.remove(this.options.draggingClass);
        this._handleElm.removeEventListener("mousedown", this._start);
        this._handleElm.removeEventListener("touchstart", this._start);
        document.removeEventListener("mousemove", this._move);
        document.removeEventListener("mouseup", this._end);
        document.removeEventListener("touchmove", this._move);
        document.removeEventListener("touchend", this._end);
    }
}

/** Keep an element within the viewport (reads/writes its inline geometry). */
function constrain(el: HTMLElement): void {
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = parseFloat(el.style.left) || 0, top = parseFloat(el.style.top) || 0;
    if (left > window.innerWidth - w) left = Math.max(window.innerWidth - w, 0); else if (left < 0) left = 0;
    if (top > window.innerHeight - h) top = Math.max(window.innerHeight - h, 0); else if (top < 0) top = 0;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
}

// ── Component ──────────────────────────────────────────────────────────────────

export interface VtWindowProps {
    title: string;
    /** The element hosted in the body — typically an <iframe>.  Appended once and
     *  never reconciled (recreating an iframe would reload it). */
    body: HTMLElement;

    top?: number;
    left?: number;
    width?: number;
    height?: number;

    closable?: boolean;
    minimizable?: boolean;
    maximizable?: boolean;
    detachable?: boolean;
    resizable?: boolean;

    /** Controlled: collapsed to the minimized strip.  Pair with onMinimizedChange. */
    minimized?: boolean;
    onMinimizedChange?: (minimized: boolean) => void;
}

export function VtWindow(props: VtWindowProps): VNode {
    const {
        title, body,
        top = 10, left = 10, width = 400, height = 300,
        closable = true, minimizable = true, maximizable = true, detachable = false, resizable = true,
        minimized = false, onMinimizedChange,
    } = props;

    const rootRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const grabRef = useRef<HTMLDivElement>(null);
    const dragMoveRef = useRef<Drag | null>(null);
    const popupRef = useRef<Window | null>(null);
    const restoreParentRef = useRef<HTMLElement | null>(null);
    const idRef = useRef(`vt-${Math.random().toString(36).slice(2)}`);

    const [maximized, setMaximized] = useState(false);
    const [focused, setFocused] = useState(false);
    const [hidden, setHidden] = useState(false);
    const [windowed, setWindowed] = useState(false);   // detached into a popup

    // Mount once: seed geometry imperatively, host the body, wire drag + focus.
    useLayoutEffect(() => {
        const el = rootRef.current!;
        el.style.top = `${top}px`;
        el.style.left = `${left}px`;
        el.style.width = `${width}px`;
        el.style.height = `${height}px`;
        bodyRef.current!.appendChild(body);
        constrain(el);

        const move = new Drag(el, headerRef.current!, { mode: "move" });
        dragMoveRef.current = move;
        const resize = resizable ? new Drag(el, grabRef.current!, { mode: "resize" }) : null;

        // Focus follows clicks: inside → focused (raised via the .focus z-index rule).
        const onDown = (e: MouseEvent) => setFocused(el.contains(e.target as Node));
        document.addEventListener("mousedown", onDown);

        return () => {
            move.destroy();
            resize?.destroy();
            document.removeEventListener("mousedown", onDown);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Minimized sticks to the bottom edge → disable vertical dragging.
    useEffect(() => {
        if (dragMoveRef.current) dragMoveRef.current.yAxis = !minimized;
        if (rootRef.current && !minimized) constrain(rootRef.current);
    }, [minimized]);

    // Detach the window into a real popup by moving the Preact mount container
    // (keeps the container node, so re-renders keep working in the popup).
    const detach = (): void => {
        const el = rootRef.current!;
        const container = el.parentElement as HTMLElement | null;
        if (!container) return;
        const features = `width=${el.offsetWidth},height=${el.offsetHeight},` +
            `top=${el.offsetTop + (window.outerHeight - window.innerHeight) / 2 + window.screenY},` +
            `left=${el.offsetLeft + (window.outerWidth - window.innerWidth) / 2 + window.screenX}`;
        const popup = window.open("", idRef.current, features);
        if (!popup) return;   // blocked
        popupRef.current = popup;
        restoreParentRef.current = container.parentElement;
        popup.document.body.appendChild(container);
        popup.document.title = title;
        document.querySelectorAll("style,link").forEach(n => popup.document.head.appendChild(n.cloneNode(true)));
        setWindowed(true);
        popup.addEventListener("beforeunload", () => {
            restoreParentRef.current?.appendChild(container);
            setWindowed(false);
            popupRef.current = null;
        });
    };

    const cls = String(vtWindow({
        mode: windowed ? "windowed" : "virtual", focused, minimized, maximized, hidden,
    }));

    return (
        <div ref={rootRef} class={cls} role="dialog" aria-label={title}>
            <div ref={headerRef} class="vt-header">
                <span class="vt-title" title={title}>{title}</span>
                <span class="vt-controls">
                    {detachable && <button class="vt-popout" title="Detach to popup" onClick={detach}>⇱</button>}
                    {maximizable && <button class="vt-maximize" title="Maximize" onClick={() => setMaximized(m => !m)}>▢</button>}
                    {minimizable && <button class="vt-minimize" title="Minimize" onClick={() => { setMaximized(false); onMinimizedChange?.(!minimized); }}>_</button>}
                    {closable && <button class="vt-close" title="Close" onClick={() => setHidden(true)}>✕</button>}
                </span>
            </div>
            <div ref={bodyRef} class="vt-body" />
            <div class="vt-footer">{resizable && <div ref={grabRef} class="vt-grab" />}</div>
        </div>
    );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
//
// Structural children keep stable class hooks (.vt-header/.vt-body/…); the root
// composer styles them via nested selectors and drives state with variants.  The
// imperative `.drag` class (added by the Drag helper) is matched with `&.drag`.

const vtWindow = css({
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    background: "$bg",
    border: "1px solid $border",
    borderRadius: 5,
    boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
    color: "$text",
    fontFamily: "monospace",

    "& .vt-header": {
        display: "flex",
        alignItems: "center",
        cursor: "grab",
        opacity: 0.6,
        userSelect: "none",
        padding: "3px 4px 3px 8px",
        background: "$headerBg",
        borderBottom: "1px solid $line",
        fontSize: 11,
        letterSpacing: 1,
    },
    "& .vt-title": {
        flexGrow: 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: "$title",
    },
    "& .vt-controls": { display: "flex", gap: 2 },
    "& .vt-controls button": {
        width: 20,
        height: 18,
        lineHeight: 1,
        cursor: "pointer",
        background: "$btnBg",
        color: "$btnText",
        border: "1px solid $border",
        borderRadius: 3,
        fontFamily: "monospace",
        fontSize: 11,
    },
    "& .vt-controls button:hover": { background: "$btnHover" },
    "& .vt-body": { position: "relative", flexGrow: 1, display: "flex", background: "#000" },
    "& .vt-body > iframe": { flex: "1 1 auto", width: "100%", height: "100%", border: 0 },
    "& .vt-footer": { position: "relative", height: 0 },
    "& .vt-grab": { cursor: "nwse-resize", position: "absolute", bottom: 0, right: 0, width: 16, height: 16 },
    "& .vt-grab::after": {
        content: "''",
        position: "absolute",
        right: 2,
        bottom: 2,
        width: 0,
        height: 0,
        borderLeft: "7px solid transparent",
        borderBottom: "7px solid $border",
    },

    // iframes swallow pointer events while the window is unfocused (default here)
    // or being dragged — see the `focused` variant and `&.drag` below.
    "& iframe": { pointerEvents: "none" },
    "&.drag": {
        willChange: "top, left, width, height",
        "& .vt-body, & iframe": { pointerEvents: "none" },
    },

    variants: {
        mode: {
            virtual: { position: "fixed", zIndex: 0 },
            windowed: {
                position: "static",
                width: "100% !important",
                height: "100% !important",
                border: "none",
                "& .vt-header": { display: "none" },
            },
        },
        focused: {
            true: { "& .vt-header": { opacity: 1 }, "& iframe": { pointerEvents: "auto" } },
        },
        minimized: {
            true: {
                position: "fixed",
                top: "auto !important",
                bottom: "0 !important",
                width: "220px !important",
                height: "auto !important",
                "& .vt-popout, & .vt-maximize, & .vt-body, & .vt-footer": { display: "none" },
            },
        },
        maximized: {
            true: {
                position: "fixed",
                inset: "0 !important",
                width: "auto !important",
                height: "auto !important",
                "& .vt-body": { overflow: "auto" },
            },
        },
        hidden: { true: { display: "none" } },
    },

    // Only floating (virtual) windows raise on focus.
    compoundVariants: [
        { mode: "virtual", focused: true, css: { zIndex: 1, boxShadow: "0 10px 34px rgba(0,0,0,0.7)" } },
    ],
});
