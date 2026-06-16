/**
 * VtWindow — a tiny virtual-window system (draggable / resizable / minimizable,
 * and detachable into a real browser popup).
 *
 * Vendored and cleaned up from Victor N.'s VtWindow (Apache-2.0):
 *   https://github.com/victornpb/VtWindow
 * Ported to TypeScript, the `Drag` helper folded in, typos fixed, dead vendor
 * CSS prefixes dropped, and a small dark theme added.  Behaviour is otherwise
 * faithful to upstream.
 *
 * Notes for hosting an <iframe> as the body (our use case — a netcode box):
 *   • `preserveFocusOrder` MUST stay false.  Upstream re-appends the root on
 *     focus to raise it, which reloads any iframe inside; we raise via z-index
 *     (the `.focus` CSS rule) instead.
 *   • `popout()` moves the root into a `window.open()` document.  Re-parenting an
 *     iframe across documents reloads it, so detaching a live peer drops its P2P
 *     connection — fine for a fresh debug view, not for keeping state.
 */

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
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight: number;
    xAxis: boolean;
    yAxis: boolean;
    draggingClass: string;

    private options: DragOptions;
    private _targetElm: HTMLElement;
    private _handleElm: HTMLElement;
    private _dragStartHandler: (e: MouseEvent | TouchEvent) => void;
    private _dragMoveHandler: (e: MouseEvent | TouchEvent) => void;
    private _dragEndHandler: (e?: MouseEvent | TouchEvent) => void;

    constructor(targetElm: HTMLElement, handleElm: HTMLElement, options?: Partial<DragOptions>) {
        this.options = Object.assign({
            mode: "move",
            minWidth: 200,
            maxWidth: Infinity,
            minHeight: 100,
            maxHeight: Infinity,
            xAxis: true,
            yAxis: true,
            draggingClass: "drag",
            useMouseEvents: true,
            useTouchEvents: true,
        }, options) as DragOptions;

        this.minWidth = this.options.minWidth;
        this.maxWidth = this.options.maxWidth;
        this.minHeight = this.options.minHeight;
        this.maxHeight = this.options.maxHeight;
        this.xAxis = this.options.xAxis;
        this.yAxis = this.options.yAxis;
        this.draggingClass = this.options.draggingClass;

        this._targetElm = targetElm;
        this._handleElm = handleElm;

        // offset from the initial click to the target's edges, and the viewport size
        let offTop = 0, offLeft = 0, offBottom = 0, offRight = 0;
        let vw = window.innerWidth;
        let vh = window.innerHeight;

        const moveOp = (x: number, y: number): void => {
            let l = x - offLeft;
            if (x - offLeft < 0) l = 0;                                          // offscreen ←
            else if (x - offRight > vw) l = vw - this._targetElm.clientWidth;    // offscreen →
            let t = y - offTop;
            if (y - offTop < 0) t = 0;                                           // offscreen ↑
            else if (y - offBottom > vh) t = vh - this._targetElm.clientHeight;  // offscreen ↓

            if (this.xAxis) this._targetElm.style.left = `${l}px`;
            if (this.yAxis) this._targetElm.style.top = `${t}px`;
        };

        const resizeOp = (x: number, y: number): void => {
            let w = x - this._targetElm.offsetLeft - offRight;
            if (x - offRight > vw) w = Math.min(vw - this._targetElm.offsetLeft, this.maxWidth);
            else if (x - offRight - this._targetElm.offsetLeft > this.maxWidth) w = this.maxWidth;
            else if (x - offRight - this._targetElm.offsetLeft < this.minWidth) w = this.minWidth;
            let h = y - this._targetElm.offsetTop - offBottom;
            if (y - offBottom > vh) h = Math.min(vh - this._targetElm.offsetTop, this.maxHeight);
            else if (y - offBottom - this._targetElm.offsetTop > this.maxHeight) h = this.maxHeight;
            else if (y - offBottom - this._targetElm.offsetTop < this.minHeight) h = this.minHeight;

            if (this.xAxis) this._targetElm.style.width = `${w}px`;
            if (this.yAxis) this._targetElm.style.height = `${h}px`;
        };

        const operation = this.options.mode === "move" ? moveOp : resizeOp;

        this._dragStartHandler = (e: MouseEvent | TouchEvent): void => {
            const touch = e.type === "touchstart";
            const me = e as MouseEvent;
            if (!((me.buttons === 1 || me.which === 1) || touch)) return;
            e.preventDefault();

            const p = touch ? (e as TouchEvent).touches[0] : me;
            const x = p.clientX, y = p.clientY;
            const r = this._targetElm.getBoundingClientRect();
            offTop = y - r.y;
            offLeft = x - r.x;
            offBottom = y - (r.y + r.height);
            offRight = x - (r.x + r.width);
            vw = window.innerWidth;
            vh = window.innerHeight;

            if (this.options.useMouseEvents) {
                document.addEventListener("mousemove", this._dragMoveHandler);
                document.addEventListener("mouseup", this._dragEndHandler);
            }
            if (this.options.useTouchEvents) {
                document.addEventListener("touchmove", this._dragMoveHandler, { passive: false });
                document.addEventListener("touchend", this._dragEndHandler);
            }
            this._targetElm.classList.add(this.draggingClass);
        };

        this._dragMoveHandler = (e: MouseEvent | TouchEvent): void => {
            e.preventDefault();
            let x: number, y: number;
            if (e.type === "touchmove") {
                const t = (e as TouchEvent).touches[0];
                x = t.clientX; y = t.clientY;
            } else {
                const me = e as MouseEvent;
                // No button down (mouseup lost outside the window) → stop dragging.
                if ((me.buttons || me.which) !== 1) { this._dragEndHandler(); return; }
                x = me.clientX; y = me.clientY;
            }
            operation(x, y);
        };

        this._dragEndHandler = (): void => {
            if (this.options.useMouseEvents) {
                document.removeEventListener("mousemove", this._dragMoveHandler);
                document.removeEventListener("mouseup", this._dragEndHandler);
            }
            if (this.options.useTouchEvents) {
                document.removeEventListener("touchmove", this._dragMoveHandler);
                document.removeEventListener("touchend", this._dragEndHandler);
            }
            this._targetElm.classList.remove(this.draggingClass);
        };

        this.enable();
    }

    /** (Re)bind the start listener to the handle. */
    enable(): void {
        if (this.options.useMouseEvents) this._handleElm.addEventListener("mousedown", this._dragStartHandler);
        if (this.options.useTouchEvents) this._handleElm.addEventListener("touchstart", this._dragStartHandler, { passive: false });
    }

    /** Tear down all listeners.  Resurrect with enable(). */
    destroy(): void {
        this._targetElm.classList.remove(this.draggingClass);
        if (this.options.useMouseEvents) {
            this._handleElm.removeEventListener("mousedown", this._dragStartHandler);
            document.removeEventListener("mousemove", this._dragMoveHandler);
            document.removeEventListener("mouseup", this._dragEndHandler);
        }
        if (this.options.useTouchEvents) {
            this._handleElm.removeEventListener("touchstart", this._dragStartHandler);
            document.removeEventListener("touchmove", this._dragMoveHandler);
            document.removeEventListener("touchend", this._dragEndHandler);
        }
    }
}

// ── VtWindow ───────────────────────────────────────────────────────────────────

type Callback = ((this: VtWindow) => void) | null;

export interface VtWindowContent {
    title?: string | HTMLElement;
    body?: string | HTMLElement;
}

export interface VtWindowOptions {
    top: number;
    left: number;
    width: number;
    height: number;

    closable: boolean;
    maximizable: boolean;
    minimizable: boolean;
    detachable: boolean;   // show the popout/detach button (upstream: "deatachable")
    resizable: boolean;

    /** Re-append on focus to raise it.  MUST be false when the body is an iframe
     *  (re-parenting reloads it); we raise via the `.focus` z-index rule instead. */
    preserveFocusOrder: boolean;
    autoMount: boolean;
    lowEnd: boolean;

    onMinimize: Callback;
    onMaximize: Callback;
    onMount: Callback;
    onUnmount: Callback;
    onShow: Callback;
    onHide: Callback;
    onPopout: Callback;
    onExitPopout: Callback;
    onFocus: Callback;
    onBlur: Callback;

    container: HTMLElement;
    template: string;
}

interface VtWindowDOM {
    header: HTMLElement;
    title: HTMLElement;
    controls: HTMLElement;
    popout: HTMLButtonElement;
    maximize: HTMLButtonElement;
    minimize: HTMLButtonElement;
    close: HTMLButtonElement;
    body: HTMLElement;
    footer: HTMLElement;
    resize: HTMLElement;
}

const DEFAULT_TEMPLATE = /* html */ `
<div role="dialog" aria-label="">
  <div name="header">
    <span name="title"><!-- title --></span>
    <span name="controls">
      <button name="popout" title="Detach to popup">⇱</button>
      <button name="maximize" title="Maximize">▢</button>
      <button name="minimize" title="Minimize">_</button>
      <button name="close" title="Close">✕</button>
    </span>
  </div>
  <div name="body"><!-- body --></div>
  <div name="footer"><div name="grab"></div></div>
</div>`;

export class VtWindow {
    readonly options: VtWindowOptions;
    /** The vt-window root element. */
    el: HTMLElement;
    readonly DOM: VtWindowDOM;

    onMinimize: Callback;
    onMaximize: Callback;
    onMount: Callback;
    onUnmount: Callback;
    onShow: Callback;
    onHide: Callback;
    onPopout: Callback;
    onExitPopout: Callback;
    onFocus: Callback;
    onBlur: Callback;

    private readonly _id = `vtwindow-${Math.random().toString(36).slice(2)}`;
    private readonly _container: HTMLElement;
    private _mounted = false;
    private _maximized = false;
    private _minimized = false;
    private _focused = false;
    private _popup: Window | null = null;

    private readonly _focusHandler: (e: MouseEvent) => void;
    private readonly _blurHandler: (e: MouseEvent) => void;
    private _dragMove: Drag;
    private _dragResize: Drag;

    constructor(content?: VtWindowContent, options?: Partial<VtWindowOptions>) {
        injectCss();

        const c: Required<VtWindowContent> = Object.assign(
            { title: "VtWindow", body: "" }, content,
        ) as Required<VtWindowContent>;

        this.options = Object.assign({
            top: 10, left: 10, width: 400, height: 300,
            closable: true, maximizable: true, minimizable: true, detachable: false, resizable: true,
            preserveFocusOrder: true, autoMount: false, lowEnd: false,
            onMinimize: null, onMaximize: null, onMount: null, onUnmount: null,
            onShow: null, onHide: null, onPopout: null, onExitPopout: null,
            onFocus: null, onBlur: null,
            container: document.body, template: DEFAULT_TEMPLATE,
        }, options) as VtWindowOptions;

        this._container = this.options.container;

        // Build the root from the template.
        const wrap = document.createElement("div");
        wrap.innerHTML = this.options.template.trim();
        if (wrap.children.length !== 1) throw new Error("VtWindow template must have exactly 1 root element");
        this.el = wrap.firstElementChild as HTMLElement;

        const $ = <T extends HTMLElement>(sel: string): T => {
            const el = this.el.querySelector<T>(sel);
            if (!el) throw new Error(`VtWindow template missing element: ${sel}`);
            return el;
        };
        this.DOM = {
            header: $("[name=header]"),
            title: $("[name=title]"),
            controls: $("[name=controls]"),
            popout: $<HTMLButtonElement>("[name=popout]"),
            maximize: $<HTMLButtonElement>("[name=maximize]"),
            minimize: $<HTMLButtonElement>("[name=minimize]"),
            close: $<HTMLButtonElement>("[name=close]"),
            body: $("[name=body]"),
            footer: $("[name=footer]"),
            resize: $("[name=grab]"),
        };

        this.onMinimize = this.options.onMinimize;
        this.onMaximize = this.options.onMaximize;
        this.onMount = this.options.onMount;
        this.onUnmount = this.options.onUnmount;
        this.onShow = this.options.onShow;
        this.onHide = this.options.onHide;
        this.onPopout = this.options.onPopout;
        this.onExitPopout = this.options.onExitPopout;
        this.onFocus = this.options.onFocus;
        this.onBlur = this.options.onBlur;

        this.DOM.close.onclick = () => this.hide();
        this.DOM.popout.onclick = () => this.popout();
        this.DOM.minimize.onclick = () => this.minimize();
        this.DOM.maximize.onclick = () => this.maximize();

        // Auto-focus when clicking inside; auto-blur when clicking outside (while focused).
        this._focusHandler = () => { if (!this._focused && this._mounted) this.focus(); };
        this._blurHandler = (e: MouseEvent) => { if (!this.el.contains(e.target as Node)) this.blur(); };

        this._dragMove = new Drag(this.el, this.DOM.header, { mode: "move" });
        this._dragResize = new Drag(this.el, this.DOM.resize, { mode: "resize" });

        this.blur();   // start blurred so the reciprocal blur/focus listeners are armed

        this.el.classList.add("vt-window");
        if (this.options.lowEnd) this.el.classList.add("low-end");

        this.top = this.options.top;
        this.left = this.options.left;
        this.width = this.options.width;
        this.height = this.options.height;
        this.closable = this.options.closable;
        this.minimizable = this.options.minimizable;
        this.maximizable = this.options.maximizable;
        this.detachable = this.options.detachable;
        this.resizable = this.options.resizable;

        this.setTitle(c.title);
        this.setBody(c.body);

        if (this.options.autoMount) this.mount();
    }

    destroy(): void {
        if (this._mounted) this.unmount();
        this._dragMove.destroy();
        this._dragResize.destroy();
        this.el.removeEventListener("mousedown", this._focusHandler);
        document.removeEventListener("mousedown", this._blurHandler);
    }

    // ── Mount / visibility ─────────────────────────────────────────────────────

    mount(): void {
        this._container.appendChild(this.el);
        this.el.classList.add("virtual");
        this._mounted = true;
        this.constrain();
        this.onMount?.call(this);
    }
    unmount(): void {
        this._container.removeChild(this.el);
        this._mounted = false;
        this.onUnmount?.call(this);
    }
    get isMounted(): boolean { return this._mounted; }

    show(): void {
        this.el.style.display = "";
        this.constrain();
        this.onShow?.call(this);
    }
    hide(): void {
        this.el.style.display = "none";
        this.onHide?.call(this);
    }

    // ── State toggles ──────────────────────────────────────────────────────────

    minimize(bool?: boolean): void {
        if (this._maximized) this.maximize(false);
        this._minimized = typeof bool === "boolean" ? bool : !this._minimized;
        this.el.classList.toggle("minimized", this._minimized);
        this._dragMove.yAxis = !this._minimized;   // minimized sticks to the bottom edge
        this.constrain();
        this.onMinimize?.call(this);
    }
    get isMinimized(): boolean { return this._minimized; }

    maximize(bool?: boolean): void {
        if (this._minimized) this.minimize(false);
        this._maximized = typeof bool === "boolean" ? bool : !this._maximized;
        this.el.classList.toggle("maximized", this._maximized);
        this.constrain();
        this.onMaximize?.call(this);
    }
    get isMaximized(): boolean { return this._maximized; }

    // ── Detach to a real popup window ──────────────────────────────────────────

    popout(): void {
        const wTop = (window.outerHeight - window.innerHeight) / 2 + window.screenY;
        const wLeft = (window.outerWidth - window.innerWidth) / 2 + window.screenX;
        const features = `width=${this.el.offsetWidth},height=${this.el.clientHeight},` +
            `top=${this.el.offsetTop + wTop},left=${this.el.offsetLeft + wLeft}`;

        const popup = window.open("", this._id, features);
        if (!popup) return;   // blocked by the popup blocker
        this._popup = popup;

        this.unmount();
        popup.document.body.appendChild(this.el);
        popup.document.title = this.DOM.title.innerText;

        // Carry our styles across so it looks the same in the detached window.
        const head = popup.document.getElementsByTagName("head")[0];
        document.querySelectorAll("style,link").forEach(el => head.appendChild(el.cloneNode(true)));

        this.el.classList.add("windowed");
        this.el.classList.remove("virtual");
        popup.onbeforeunload = () => this.exitpopout();
        this.onPopout?.call(this);
    }

    exitpopout(): void {
        this.el.classList.remove("windowed");
        this.mount();
        this._popup = null;
        this.onExitPopout?.call(this);
    }
    get isPoppedOut(): boolean { return this._popup !== null; }

    // ── Focus ──────────────────────────────────────────────────────────────────

    focus(): void {
        if (!this._mounted) throw new Error("Cannot focus an unmounted VtWindow");
        // Raising by re-appending reloads iframes; only do it when explicitly opted in.
        if (this.options.preserveFocusOrder) this._container.appendChild(this.el);
        this.el.classList.add("focus");
        this._focused = true;
        this.el.removeEventListener("mousedown", this._focusHandler);
        document.addEventListener("mousedown", this._blurHandler);
        this.constrain();
        this.onFocus?.call(this);
    }

    blur(): void {
        this.el.classList.remove("focus");
        this._focused = false;
        document.removeEventListener("mousedown", this._blurHandler);
        this.el.addEventListener("mousedown", this._focusHandler);
        this.constrain();
        this.onBlur?.call(this);
    }
    get isFocused(): boolean { return this._focused; }

    /** Keep the window within the viewport. */
    constrain(): void {
        if (this.left > window.innerWidth - this.width) this.left = Math.max(window.innerWidth - this.width, 0);
        else if (this.left < 0) this.left = 0;
        if (this.top > window.innerHeight - this.height) this.top = Math.max(window.innerHeight - this.height, 0);
        else if (this.top < 0) this.top = 0;
        if (this.width > window.innerWidth) this.width = window.innerWidth;
        if (this.height > window.innerHeight) this.height = window.innerHeight;
    }

    // ── Content ────────────────────────────────────────────────────────────────

    setTitle(title: string | HTMLElement): void {
        if (typeof title === "string") this.DOM.title.innerHTML = title;
        else { this.DOM.title.innerHTML = ""; this.DOM.title.appendChild(title); }
        const text = this.DOM.title.innerText;
        this.DOM.title.setAttribute("title", text);
        this.el.setAttribute("aria-label", text);
    }
    setBody(body: string | HTMLElement): void {
        if (typeof body === "string") this.DOM.body.innerHTML = body;
        else { this.DOM.body.innerHTML = ""; this.DOM.body.appendChild(body); }
    }

    // ── Feature toggles ────────────────────────────────────────────────────────

    set resizable(bool: boolean) {
        this.DOM.resize.style.display = bool ? "" : "none";
        if (bool) this._dragResize.enable();
        else this._dragResize.destroy();
    }
    set closable(bool: boolean) { this.DOM.close.disabled = !bool; }
    set minimizable(bool: boolean) { this.DOM.minimize.disabled = !bool; }
    set maximizable(bool: boolean) {
        this.DOM.maximize.disabled = !bool;
        this.DOM.title.ondblclick = bool ? () => this.maximize() : null;
    }
    set detachable(bool: boolean) { this.DOM.popout.disabled = !bool; }

    // ── Geometry (px) ──────────────────────────────────────────────────────────

    set top(px: number) { this.el.style.top = `${px}px`; }
    get top(): number { return parseFloat(this.el.style.top) || 0; }
    set left(px: number) { this.el.style.left = `${px}px`; }
    get left(): number { return parseFloat(this.el.style.left) || 0; }
    set width(px: number) { this.el.style.width = `${px}px`; }
    get width(): number { return parseFloat(this.el.style.width) || 0; }
    set height(px: number) { this.el.style.height = `${px}px`; }
    get height(): number { return parseFloat(this.el.style.height) || 0; }
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const VT_CSS = /* css */ `
.vt-window { overflow: hidden; display: flex; flex-direction: column;
  background: #0a0e17; border: 1px solid #2a5c8a; border-radius: 5px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.55); color: #cdd; font-family: monospace; }
.vt-window.virtual { position: fixed; z-index: 0; }
.vt-window.virtual.focus { z-index: 1; box-shadow: 0 10px 34px rgba(0,0,0,0.7); }
.vt-window.windowed { position: static; width: 100% !important; height: 100% !important; border: none; }
.vt-window.windowed [name=header] { display: none; }
.vt-window.minimized { position: fixed; top: auto !important; bottom: 0 !important;
  width: 220px !important; height: auto !important; }
.vt-window.minimized [name=popout],
.vt-window.minimized [name=maximize],
.vt-window.minimized [name=body],
.vt-window.minimized [name=footer] { display: none; }
.vt-window.maximized { position: fixed; inset: 0 !important; width: auto !important; height: auto !important; }
.vt-window.maximized [name=body] { overflow: auto; }
.vt-window [name=header] { display: flex; align-items: center; cursor: grab;
  opacity: 0.6; user-select: none; padding: 3px 4px 3px 8px; background: #0d1626;
  border-bottom: 1px solid #1a2233; font-size: 11px; letter-spacing: 1px; }
.vt-window.focus [name=header] { opacity: 1; }
.vt-window [name=title] { flex-grow: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #88aacc; }
.vt-window [name=controls] { display: flex; gap: 2px; }
.vt-window [name=controls] button { width: 20px; height: 18px; line-height: 1; cursor: pointer;
  background: #16243a; color: #adf; border: 1px solid #2a5c8a; border-radius: 3px; font-family: monospace; font-size: 11px; }
.vt-window [name=controls] button:hover:not(:disabled) { background: #26527c; }
.vt-window [name=controls] button:disabled { display: none; }
.vt-window [name=body] { position: relative; flex-grow: 1; display: flex; background: #000; }
.vt-window [name=body] > iframe { flex: 1 1 auto; width: 100%; height: 100%; border: 0; }
.vt-window [name=footer] { position: relative; height: 0; }
.vt-window [name=grab] { cursor: nwse-resize; position: absolute; bottom: 0; right: 0;
  width: 16px; height: 16px; }
.vt-window [name=grab]:after { content: ''; position: absolute; right: 2px; bottom: 2px;
  width: 0; height: 0; border-left: 7px solid transparent; border-bottom: 7px solid #2a5c8a; }
.vt-window.drag { will-change: top, left, width, height; }
/* iframes swallow pointer events during drag and while the window is unfocused. */
.vt-window:not(.focus) iframe, .vt-window.drag [name=body] { pointer-events: none; }
`;

let cssInjected = false;
function injectCss(): void {
    if (cssInjected || typeof document === "undefined") return;
    cssInjected = true;
    const style = document.createElement("style");
    style.id = "vt-window-css";
    style.textContent = VT_CSS;
    document.head.appendChild(style);
}
