/**
 * Realtime perf dashboard for the host page (billboard.js).
 *
 * `mountMetrics(container)` renders a small grid of streaming line charts and listens for
 * `{ type: "metrics" }` window messages.  Each box's client shell (one per box: host +
 * guest) forwards a sample ~4 Hz via `window.parent.postMessage`; the message carries the
 * box's `role` and a flat `fields` bag.  Every chart plots its configured fields with a
 * separate line *per role*, sliding over the most recent `WINDOW` samples — so the host's
 * and guest's curves sit side-by-side on the same axes.
 *
 * billboard.js (with its bundled d3) is loaded as a global via CDN on the host page, so
 * this module carries no bundler dependency — it just references `globalThis.bb`.  It is
 * otherwise game-agnostic: the only war2-specific knowledge is the field names in CHARTS
 * and the sim tick budget guide-line.
 */

import { globalCss, palette } from "theme";

// billboard.js UMD global (billboard.pkgd.* bundles d3 + registers every chart type, so
// `type: "line"` resolves as a string — the modular `line()` import is ESM-only).
declare const bb: { generate(cfg: unknown): BbChart };
interface BbChart { load(args: unknown): void; flow(args: unknown): void; }

/** A perf sample forwarded from a box's client shell. */
interface MetricsMsg {
    type:   "metrics";
    role:   string;                   // "host" | "peer"
    t:      number;                   // Date.now() at emit
    fields: Record<string, number>;   // fps, frameMs, tickMs, rtt, lead, units, bytesIn, bytesOut
}

interface ChartDef {
    id:      string;
    title:   string;
    fields:  string[];                // fields to plot (one line per field × role)
    budget?: { value: number; text: string };   // optional horizontal guide line
}

/** Fields that arrive as "bytes since the last sample" → charted as KB/s. */
const RATE_FIELDS = new Set(["bytesIn", "bytesOut"]);

/** Samples retained per series (~30 s at the FLOW_MS tick). */
const WINDOW = 120;

/** Display advance cadence — charts append one sample-and-hold point per tick, so chart
 *  cost is fixed regardless of how many boxes report or how fast.  Matches the workers'
 *  ~250 ms emit, so each role contributes ~one fresh value per tick. */
const FLOW_MS = 250;

const CHARTS: ChartDef[] = [
    { id: "fps",  title: "FPS",                 fields: ["fps"] },
    { id: "tick", title: "Sim tick (ms)",        fields: ["tickMs"], budget: { value: 50, text: "budget 50ms" } },
    { id: "net",  title: "Latency: rtt / lead",  fields: ["rtt", "lead"] },
    { id: "wire", title: "Wire (KB/s) · units",  fields: ["bytesOut", "bytesIn", "units"] },
    { id: "heap", title: "Heap (MB) · Chromium", fields: ["heap"] },
];

/** Friendly, stable colours so a role keeps its hue across charts (theme accents). */
const ROLE_COLOR: Record<string, string> = { host: palette.accent, peer: palette.accent2 };

/**
 * Render the dashboard into `container` and start consuming `{type:"metrics"}` window
 * messages.  Returns a teardown function that removes the listener.
 */
export function mountMetrics(container: HTMLElement): () => void {
    injectStyles();
    container.classList.add("metrics-grid");

    // Display data is appended on a fixed FLOW_MS tick (sample-and-hold of each role's latest
    // value), so chart cost is decoupled from message rate.  Steady state uses billboard's
    // incremental flow() (O(1) append + expire); ragged phases (a chart still filling, or a
    // role joining late → uneven series lengths) fall back to a full load() from these buffers.
    const latest = new Map<string, Record<string, number>>();        // role → newest display values
    const series = new Map<string, { x: number[]; y: number[] }>();  // role|field → buffer (≤ WINDOW)
    const roles  = new Set<string>();
    const lastT  = new Map<string, number>();   // role → last message time, for rate dt
    const charts = new Map<string, { chart: BbChart; names: string; full: boolean }>();
    const t0 = Date.now();

    for (const def of CHARTS) {
        const card = document.createElement("div");
        card.className = "metrics-card";
        const h = document.createElement("div");
        h.className = "metrics-title";
        h.textContent = def.title;
        const body = document.createElement("div");
        body.id = `metrics-${def.id}`;
        body.className = "metrics-chart";
        card.append(h, body);
        container.appendChild(card);
    }

    const seriesId = (role: string, field: string) => `${role}|${field}`;
    /** Human label for a series — drop a single-field chart's redundant field name. */
    const label = (def: ChartDef, role: string, field: string) =>
        def.fields.length === 1 ? role : `${role} ${field}`;

    /** A message only refreshes the latest values; charts advance on the FLOW_MS tick. */
    function ingest(msg: MetricsMsg): void {
        roles.add(msg.role);
        const dtMs = lastT.has(msg.role) ? msg.t - lastT.get(msg.role)! : FLOW_MS;
        lastT.set(msg.role, msg.t);
        const f: Record<string, number> = {};
        for (const [field, raw] of Object.entries(msg.fields)) {
            f[field] = RATE_FIELDS.has(field)
                ? Math.round(raw / (dtMs / 1000) / 1024 * 100) / 100   // bytes/sample → KB/s
                : raw;
        }
        latest.set(msg.role, f);
    }

    interface Present { name: string; role: string; field: string; value: number; }

    /** One display step: sample-and-hold each role's latest into the buffers, then advance each
     *  chart — incrementally via flow() when it's full & stable, else a load() from the buffers. */
    function step(): void {
        const tsec = Math.round((Date.now() - t0) / 100) / 10;
        for (const def of CHARTS) {
            const present: Present[] = [];
            for (const role of roles) {
                const f = latest.get(role);
                if (!f) continue;
                for (const field of def.fields) {
                    if (f[field] === undefined) continue;
                    present.push({ name: label(def, role, field), role, field, value: f[field] });
                }
            }
            if (!present.length) continue;

            // Append to the bounded buffers (source of truth for a load() fallback).
            for (const p of present) {
                const key = seriesId(p.role, p.field);
                let s = series.get(key);
                if (!s) { s = { x: [], y: [] }; series.set(key, s); }
                s.x.push(tsec); s.y.push(p.value);
                if (s.x.length > WINDOW) { s.x.shift(); s.y.shift(); }
            }

            const names = present.map(p => p.name).sort().join("|");
            const full  = present.every(p => series.get(seriesId(p.role, p.field))!.x.length >= WINDOW);
            const entry = charts.get(def.id);

            // Pure flow only once the chart exists, its series set is unchanged, and every line is
            // full — so a single length:1 trims them uniformly.  Otherwise (re)load from buffers.
            if (entry && entry.names === names && entry.full && full) {
                const columns: (string | number)[][] = [];
                for (const p of present) columns.push([`${p.name}_x`, tsec], [p.name, p.value]);
                entry.chart.flow({ columns, length: 1, duration: 0 });
            } else {
                regenerate(def, present, names, full);
            }
        }
    }

    /** First-time generate, or a load() refresh when the series set changed or a line is still
     *  filling (ragged lengths → flow's single length can't trim them evenly). */
    function regenerate(def: ChartDef, present: Present[], names: string, full: boolean): void {
        const columns: (string | number)[][] = [];
        const xs: Record<string, string> = {};
        const colors: Record<string, string> = {};
        for (const p of present) {
            const s = series.get(seriesId(p.role, p.field))!;
            const xName = `${p.name}_x`;
            columns.push([xName, ...s.x], [p.name, ...s.y]);
            xs[p.name] = xName;
            colors[p.name] = ROLE_COLOR[p.role] ?? "#888";
        }

        const entry = charts.get(def.id);
        if (entry) {
            entry.chart.load({ columns, xs, unload: false });
            entry.names = names; entry.full = full;
            return;
        }
        const chart = bb.generate({
            bindto: `#metrics-${def.id}`,
            data: { type: "line", xs, columns, colors },
            axis: {
                x: { tick: { count: 6, format: (v: number) => `${Math.round(v)}s` } },
                y: { min: 0, padding: { bottom: 0 } },
            },
            grid: def.budget ? { y: { lines: [def.budget] } } : undefined,
            point: { show: false },
            transition: { duration: 0 },
            legend: { position: "inset" },
            size: { height: 200 },
        });
        charts.set(def.id, { chart, names, full });
    }

    const onMessage = (e: MessageEvent): void => {
        const d = e.data as MetricsMsg | null;
        if (d && d.type === "metrics" && d.fields) ingest(d);
    };
    window.addEventListener("message", onMessage);
    const timer = setInterval(step, FLOW_MS);
    return () => { clearInterval(timer); window.removeEventListener("message", onMessage); };
}

// Dark theme to match the host page — billboard.css (CDN) is light by default, so we override
// its global `.bb-*` SVG classes with the shared palette.  Series line colours come from
// data.colors (ROLE_COLOR); these rules cover the chrome (axes/grid/legend).  Stitches
// `globalCss` (not a raw <style> string) — keeps the literal `.bb-*` selectors billboard needs,
// and dedupes injection itself, so no manual guard.  Values stay `palette.*` (raw hex) since
// `fill`/`stroke` aren't token-mapped and billboard reads plain colours.
const injectStyles = globalCss({
    ".metrics-grid": { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginTop: 10 },
    ".metrics-card": { background: palette.headerBg, border: `1px solid ${palette.line}`, borderRadius: 5, padding: "6px 10px 2px" },
    ".metrics-title": { font: "600 11px/1.4 monospace", color: palette.title, letterSpacing: "0.05em", marginBottom: 2 },
    ".metrics-card .bb svg": { font: "10px/1.2 monospace" },
    ".metrics-card .bb text, .metrics-card .bb-axis text, .metrics-card .bb-legend-item text": { fill: palette.text },
    ".metrics-card .bb-legend-background": { fill: palette.headerBg, stroke: palette.line, opacity: 0.9 },
    ".metrics-card .bb-axis path.domain, .metrics-card .bb-axis line": { stroke: palette.line },
    ".metrics-card .bb-grid line": { stroke: palette.line, opacity: 0.55 },
    ".metrics-card .bb-ygrid-line line, .metrics-card .bb-xgrid-line line": { stroke: palette.accent2, opacity: 0.8, strokeDasharray: "4 3" },
    ".metrics-card .bb-ygrid-line text, .metrics-card .bb-xgrid-line text": { fill: palette.accent2 },
    ".metrics-card .bb-tooltip": { background: palette.bg, color: palette.text, border: `1px solid ${palette.border}`, boxShadow: "none", opacity: 0.97 },
    ".metrics-card .bb-tooltip th": { background: palette.headerBg, color: palette.title },
    ".metrics-card .bb-tooltip td": { background: palette.bg, color: palette.text, borderLeft: "none" },
});
