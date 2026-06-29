/**
 * In-game dev console (Quake-style — press ` / ~ to toggle).
 *
 * Captures console.* output, uncaught errors, and unhandled rejections into a
 * capped ring buffer and renders them in a DOM overlay above the Phaser canvas.
 * This exists because each client runs in its own iframe, where raw console
 * output is easy to miss (it lands in the iframe's own DevTools context, not the
 * top frame) — so we surface it on-page instead. Original console methods are
 * still invoked, so DevTools keeps working normally when it's open.
 *
 * Call initGameConsole() once, as early as possible in the client entry.
 */

type Level = "log" | "info" | "warn" | "error" | "debug";
interface Entry { ts: number; level: Level; msg: string; }

const MAX_LINES = 500;
const buffer: Entry[] = [];

let overlay: HTMLDivElement | null = null;
let listEl:  HTMLDivElement | null = null;
let visible = false;
let started = false;
let sink: ((level: Level, msg: string) => void) | null = null;

/** Register a forwarder for this thread's OWN console lines (e.g. relay to the debug server). Called
 *  only from the main-thread console patch, not from pushConsole, so relayed worker lines aren't doubled. */
export function setConsoleSink(fn: (level: Level, msg: string) => void): void {
    if (!import.meta.env.DEV) return;   // dev-only; lets the whole overlay tree-shake out of prod
    sink = fn;
}

const LEVEL_COLOR: Record<Level, string> = {
    log:   "#cdd",
    info:  "#7a9",
    debug: "#69b",
    warn:  "#da7",
    error: "#e55",
};

/** Render console args the way the console would — strings as-is, else JSON. */
function format(args: unknown[]): string {
    return args.map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
}

function push(level: Level, msg: string): void {
    const entry = { ts: Date.now(), level, msg };
    buffer.push(entry);
    if (buffer.length > MAX_LINES) buffer.shift();
    if (visible && listEl) appendLine(entry);
}

function appendLine(entry: Entry): void {
    const line = document.createElement("div");
    const ts = new Date(entry.ts).toTimeString().slice(0, 8);
    line.textContent = `${ts}  ${entry.msg}`;
    line.style.cssText = `color:${LEVEL_COLOR[entry.level]};white-space:pre-wrap;word-break:break-word;`;
    listEl!.appendChild(line);
    // Keep the DOM bounded too, not just the buffer.
    while (listEl!.childElementCount > MAX_LINES) listEl!.removeChild(listEl!.firstChild!);
    listEl!.parentElement!.scrollTop = listEl!.parentElement!.scrollHeight;
}

function buildOverlay(): void {
    overlay = document.createElement("div");
    overlay.style.cssText = [
        "position:fixed", "top:0", "left:0", "right:0", "height:40vh",
        "background:rgba(7,11,17,0.92)", "border-bottom:1px solid #2a5c8a",
        "color:#cdd", "font:11px/1.5 monospace", "padding:6px 10px",
        "overflow-y:auto", "z-index:99999", "display:none",
    ].join(";");

    listEl = document.createElement("div");
    overlay.appendChild(listEl);
    document.body.appendChild(overlay);
}

function toggle(): void {
    if (!overlay) buildOverlay();
    visible = !visible;
    overlay!.style.display = visible ? "block" : "none";
    if (visible) {
        // Rebuild from the buffer so lines logged while hidden are shown.
        listEl!.replaceChildren();
        for (const entry of buffer) appendLine(entry);
    }
}

/** Patch console + global error handlers, and bind the toggle key. Idempotent. */
export function initGameConsole(): void {
    if (!import.meta.env.DEV) return;   // dev aid only — never patch console / bind listeners in prod
    if (started) return;
    started = true;

    for (const level of ["log", "info", "warn", "error", "debug"] as Level[]) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            const m = format(args);
            push(level, m);
            try { sink?.(level, m); } catch { /* never let the relay break logging */ }
            original(...args);
        };
    }

    window.addEventListener("error", (e) => push("error", `Uncaught ${e.message}  (${e.filename}:${e.lineno})`));
    window.addEventListener("unhandledrejection", (e) => push("error", `Unhandled rejection: ${format([e.reason])}`));

    // Quake-style: the ` / ~ key (code "Backquote") toggles the console.
    window.addEventListener("keydown", (e) => {
        if (e.code !== "Backquote") return;
        e.preventDefault();
        toggle();
    }, true);
}

/** Feed an externally-sourced line (e.g. relayed worker console — see debug/workerConsole.ts) into the
 *  overlay, tagged so its origin is clear. */
export function pushConsole(level: string, msg: string): void {
    if (!import.meta.env.DEV) return;   // overlay is dev-only
    const lvl: Level = (["log", "info", "warn", "error", "debug"] as Level[]).includes(level as Level) ? (level as Level) : "log";
    push(lvl, `[worker] ${msg}`);
}
