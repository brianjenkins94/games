/**
 * Client shell (main thread) — runs in each iframe.  Host-authoritative model:
 *
 *   • Host spawns the referee worker (worker/referee.worker.ts) — the authoritative
 *     sim of both teams — and plays against it in-process.
 *   • Guest spawns a thin client worker (worker/client.worker.ts) that relays over
 *     the data channel; the guest holds no authoritative state.
 *
 * Either way this shell is the same: it bootstraps the PeerJS connection
 * (RTCPeerConnection is main-thread only), hands the RTCDataChannel to its worker
 * (transferred on Chromium, else relayed via postMessage), owns Phaser rendering +
 * input drawing from the worker's per-tick fog snapshots, and owns selection +
 * the advisory placement-ghost check (the referee validates builds authoritatively
 * and mints all unit ids).
 */
import { createCommandCardController, type CommandCardController } from "./commandCardController";
import { FP, TILE_PX, tileCenterFP, fpToTile, snapWalkFP } from "../game/components";
import { unitTypeId, unitTypeName, unitFootprint } from "../game/unitTypes";
import mapJson from "../assets/maps/ladder/Plains of snow BNE.json";
import tilesetUrl from "../assets/tilesets/winter.png";
import terrainData from "../assets/terrain.json";
import { CmdType, type Command, type SpawnCmd, type SpeedCmd } from "../net/protocol";
import { openPeer, connectTo } from "../net/peer";
import type { DataConnection } from "peerjs";
import {
    startPhaser, type Renderer, type UnitPrediction,
    rebuildMap, setRenderState, setSelectedUids, setPrediction,
    setTargetingCursor, showPlacementGhost,
} from "../render/renderer";
import { showCommandCard, showStatus } from "../render/hud";
import productionJson from "../assets/production.json";
import { initGameConsole, pushConsole, setConsoleSink } from "../debug/console";
import type { MainToWorker, WorkerToMain, RenderState, RenderUnit, MetricsSample } from "../worker/ipc";
import type { MapInfo } from "../game/world";
import type { WorldSnapshot } from "../game/snapshot";
import type { PeerReadyMsg, ConnectMsg, ClientReadyMsg } from "harness/client";

// In-game console (press ` / ~). Set up first so it captures everything below.
initGameConsole();

// ── Map config ──────────────────────────────────────────────────────────────────

function mapProp<T>(name: string, fallback: T): T {
    const props = (mapJson as any).properties as Array<{ name: string; value: unknown }> | undefined;
    const p = props?.find(q => q.name === name);
    return p !== undefined ? (p.value as T) : fallback;
}

// Snap a move click to the 8px collision grid, not the 32px tile centre — so a group can anchor
// where you clicked (sub-tile), not only on the tile lattice.  The sim re-snaps to 8px anyway.
function snapClickFP(fp: number): number {
    return snapWalkFP(fp);
}

const SEED = 0xc0ffee;

const _mapAny      = mapJson as any;
const _tilesetName = (_mapAny.tilesets?.[0]?.name as string ?? "winter").replace("summer", "forest");
const _terrainArr: number[] = (terrainData as any)[_tilesetName] ?? [];
const _gids: number[]       = _mapAny.layers?.find((l: any) => l.type === "tilelayer")?.data ?? [];

const mapInfo: MapInfo = {
    gids:       _gids,
    mapW:       _mapAny.width  as number,
    mapH:       _mapAny.height as number,
    terrainArr: _terrainArr,
};

const p0x = mapProp("p0_startX", 32), p0y = mapProp("p0_startY", 32);
const p1x = mapProp("p1_startX", 96), p1y = mapProp("p1_startY", 96);
const SPAWN_COUNT = 4;

// The host page we report to (pairing, metrics, debug relay): our parent when nested in its iframe,
// or our opener once popped out into our own standalone tab/window (where our parent is the tab).
const host = window.opener ?? window.parent;

// ── Runtime state ─────────────────────────────────────────────────────────────

let myTeam  = 0;
let selfRole: "host" | "peer" = "host";   // labels this box's metrics on the host page
let pendingRestore: WorldSnapshot | null = null;   // host-box restore snapshot (applied after boot)
let worker: Worker | null = null;
let renderer:  Renderer | null = null;
let cardController: CommandCardController | null = null;

// Relay-mode channel (main thread keeps it); null in transfer mode.
let relayChannel: RTCDataChannel | null = null;

// Latest snapshot-derived state used by the main thread for UI decisions.
const latestUnits  = new Map<number, RenderUnit>();
let   occupiedTiles = new Set<number>();
let   passability: Uint8Array | null = null;
let   mapTW = mapInfo.mapW, mapTH = mapInfo.mapH;
let   selectedUids = new Set<number>();   // stable unit-ids; UI state

// Client-side prediction: own units get an instant facing/marker the moment a
// command is issued, dropped once the authoritative snapshot reflects the move
// (mtActive) or after PREDICT_MS (e.g. a move the sim rejected).  Shared by
// reference with the renderer.
const predicted = new Map<number, UnitPrediction>();
const PREDICT_MS = 250;

/** 8-way facing (0=N..7=NW, clockwise) from a world-FP delta — matches the sim's
 *  DIR encoding (movement.ts dirFromDelta / world.ts octantFromDelta). */
function octant(dx: number, dy: number): number {
    const a = (Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
    return Math.round(a / (Math.PI / 4)) & 7;
}

// ── Selection / card helpers ────────────────────────────────────────────────────

function ownSelection(): number[] {
    return [...selectedUids].filter(uid => latestUnits.get(uid)?.team === myTeam);
}

function refreshCard(): void {
    if (!cardController) return;
    const primary = ownSelection()[0];
    const type = primary !== undefined ? unitTypeName(latestUnits.get(primary)!.type) : null;
    cardController.setSelection(type);
    refreshStatus();
}

/** Uid of the selected building iff a single production-capable building is selected (drives rally). */
function rallyableBuildingUid(): number | undefined {
    const sel = ownSelection();
    if (sel.length !== 1) return undefined;
    const u = latestUnits.get(sel[0]);
    if (!u || u.fw === 0) return undefined;
    const trains = (productionJson as Record<string, { trains?: string[] }>)[unitTypeName(u.type)]?.trains;
    return trains && trains.length ? sel[0] : undefined;
}

/** Push the primary selection's queue (production / action) into .hud-status. */
function refreshStatus(): void {
    if (!renderer) return;
    const primary = ownSelection()[0];
    const u = primary !== undefined ? latestUnits.get(primary) : undefined;
    if (u?.prod && u.prod.queue.length) {
        showStatus(renderer, { kind: "production", prod: { items: u.prod.queue, ticksLeft: u.prod.ticksLeft, ticksTotal: u.prod.ticksTotal } });
    } else if (u?.orders && u.orders.length) {
        showStatus(renderer, { kind: "orders", count: u.orders.length });
    } else {
        showStatus(renderer, null);
    }
}

/** Hand a command to the worker and update the local prediction overlay. */
function emitCommand(cmd: Command): void {
    worker!.postMessage({ kind: "command", cmd } satisfies MainToWorker);
    if (cmd.type === CmdType.MOVE) {
        const now = performance.now();
        for (const uid of cmd.unitIds) {
            const u = latestUnits.get(uid);
            if (u) predicted.set(uid, { dir: octant(cmd.txFP - u.x, cmd.tyFP - u.y), mtx: cmd.txFP, mty: cmd.tyFP, at: now });
        }
    } else if (cmd.type === CmdType.STOP) {
        for (const uid of cmd.unitIds) predicted.delete(uid);
    }
}

// ── Game speed ───────────────────────────────────────────────────────────────────
// Adjustable game speed: a SPEED command asks the referee to change the authoritative speed, which
// it applies and broadcasts to both boxes (so they stay in step). `[` slows, `]` speeds up through
// the steps below; the harness can also drive it via a `{ type: "speed", speed }` parent message.
const SPEEDS = [0.5, 1, 2, 3];
let speedIdx = 1;   // index into SPEEDS; 1× by default

function requestSpeed(s: number): void {
    if (!worker) return;
    worker.postMessage({ kind: "command", cmd: { type: CmdType.SPEED, speed: s } satisfies SpeedCmd } satisfies MainToWorker);
    console.info(`game speed → ${s}×`);
}

window.addEventListener("keydown", (e) => {
    if (e.key === "[" || e.key === "]") {
        speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, speedIdx + (e.key === "]" ? 1 : -1)));
        requestSpeed(SPEEDS[speedIdx]);
        return;
    }
    // Backslash (\) flags the current moment as a pathing incident — the referee captures a snapshot
    // ring + recent commands for retroactive analysis via the inspector (dev only).  (Backquote is the
    // in-game console toggle — see debug/console.ts — so the flag key must not collide with it.)
    if (import.meta.env.DEV && e.code === "Backslash" && worker) {
        worker.postMessage({ kind: "flag-incident" } satisfies MainToWorker);
        console.info("flagged pathing incident @ current tick");
    }
});

/** Placement-ghost validity, computed locally from the latest snapshot + static
 *  passability.  Advisory only — the worker re-validates BUILD authoritatively. */
function canPlaceBuildingLocal(tileX: number, tileY: number, typeId: number): boolean {
    const [fw, fh] = unitFootprint(typeId);
    for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
            const tx = tileX + x, ty = tileY + y;
            if (tx < 0 || ty < 0 || tx >= mapTW || ty >= mapTH) return false;
            const idx = ty * mapTW + tx;
            if (passability && passability[idx]) return false;
            if (occupiedTiles.has(idx)) return false;
        }
    }
    return true;
}

// ── Inspector badge (DOM; worker owns the debug WS and posts the count) ──────────

function updateInspectorBadge(n: number): void {
    const ID = "claude-inspector-badge";
    let badge = document.getElementById(ID);
    if (n > 0) {
        if (!badge) {
            badge = document.createElement("div");
            badge.id = ID;
            badge.style.cssText = [
                "position:fixed", "top:8px", "right:8px",
                "background:#6d28d9", "color:#fff",
                "font:bold 11px/1 monospace", "padding:4px 8px",
                "border-radius:4px", "z-index:9999", "pointer-events:none",
                "letter-spacing:0.05em",
            ].join(";");
            document.body.appendChild(badge);
        }
        badge.textContent = `🤖 Claude (${n})`;
    } else {
        badge?.remove();
    }
}

// ── Scenario/test label badge (upper-left; set by the e2e harness via `set-label`) ──
function updateScenarioBadge(text: string): void {
    const ID = "scenario-label-badge";
    let badge = document.getElementById(ID);
    if (text) {
        if (!badge) {
            badge = document.createElement("div");
            badge.id = ID;
            badge.style.cssText = [
                "position:fixed", "top:8px", "left:8px",
                "background:#dc2626", "color:#fff",
                "font:bold 11px/1 monospace", "padding:4px 8px",
                "border-radius:4px", "z-index:9999", "pointer-events:none",
                "letter-spacing:0.05em", "max-width:60vw", "white-space:nowrap",
                "overflow:hidden", "text-overflow:ellipsis",
            ].join(";");
            document.body.appendChild(badge);
        }
        badge.textContent = `🧪 ${text}`;
    } else {
        badge?.remove();
    }
}

/** Pathing auto-detector badge (upper-right): count of units currently in a pathological state. */
function updatePathologyBadge(n: number): void {
    if (!import.meta.env.DEV) return;   // detector that drives this is dev-only; lets the body tree-shake
    const ID = "pathology-badge";
    let badge = document.getElementById(ID);
    if (n > 0) {
        if (!badge) {
            badge = document.createElement("div");
            badge.id = ID;
            badge.style.cssText = [
                "position:fixed", "top:8px", "right:8px",
                "background:#d97706", "color:#fff",
                "font:bold 11px/1 monospace", "padding:4px 8px",
                "border-radius:4px", "z-index:9999", "pointer-events:none",
                "letter-spacing:0.05em", "white-space:nowrap",
            ].join(";");
            document.body.appendChild(badge);
        }
        badge.textContent = `⚠ ${n} pathing`;
    } else {
        badge?.remove();
    }
}

// ── Worker messages ─────────────────────────────────────────────────────────────

function onWorkerMessage(ev: MessageEvent<WorkerToMain>): void {
    const msg = ev.data;
    switch (msg.kind) {
        case "ready":
            passability = msg.passability;
            mapTW = msg.mapW; mapTH = msg.mapH;
            break;
        case "render":          onRender(msg.state); break;
        case "scenario-map":    if (renderer) rebuildMap(renderer, msg.gids, msg.mapW, msg.mapH); break;
        case "metrics":         onMetrics(msg.sample); break;
        case "net-out":         relayChannel?.send(msg.data); break;   // relay mode
        case "inspector-count": updateInspectorBadge(msg.n); break;
        case "scenario-label":  updateScenarioBadge(msg.text); break;
        case "pathology":       updatePathologyBadge(msg.n); break;
        case "worker-console":  pushConsole(msg.level, msg.msg); break;
        // Host-state heartbeat → host page, which restores it into a reloaded host box (popout etc.).
        case "snapshot":        host.postMessage({ type: "host-snapshot", snap: msg.snap }, "*"); break;
        // Step debugger: surface sim halts + state up to the host page (→ the VS Code adapter).
        case "stopped":
        case "debug-state":     host.postMessage({ source: "war2", type: "sim-debug-event", role: selfRole, msg }, "*"); break;
    }
}

/** Forward a worker perf sample to the host page (this box's parent), tagged with our
 *  role and stamped with fps/frameMs — the only signals the worker can't see itself.
 *  The metrics package on the host page charts host vs guest from these. */
function onMetrics(sample: MetricsSample): void {
    const frameMs = renderer?.frameMs ?? 0;
    const fps = frameMs > 0 ? Math.round(1000 / frameMs) : 0;
    const fields: Record<string, number> = { ...sample, fps, frameMs: Math.round(frameMs * 10) / 10 };
    // JS heap — Chromium-only (`performance.memory` is main-thread + Chromium); absent
    // elsewhere, so the heap chart simply has no data on Firefox/Safari.
    const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) fields.heap = Math.round(mem.usedJSHeapSize / 1048576 * 10) / 10;   // MB
    host.postMessage({ type: "metrics", role: selfRole, t: Date.now(), fields }, "*");
}

function onRender(state: RenderState): void {
    // Refresh the snapshot-derived caches the main thread reasons over.
    latestUnits.clear();
    const occ = new Set<number>();
    for (const u of state.units) {
        latestUnits.set(u.uid, u);
        if (u.fw > 0) {
            const tlx = fpToTile(u.x) - (u.fw >> 1), tly = fpToTile(u.y) - (u.fh >> 1);
            for (let y = 0; y < u.fh; y++)
                for (let x = 0; x < u.fw; x++) occ.add((tly + y) * mapTW + (tlx + x));
        } else {
            occ.add(fpToTile(u.y) * mapTW + fpToTile(u.x));
        }
    }
    occupiedTiles = occ;

    // Reconcile prediction: drop once authority reflects the move (mtActive) or the
    // unit is gone, and time out predictions the sim never acted on (rejected move).
    const now = performance.now();
    for (const [uid, p] of predicted) {
        const u = latestUnits.get(uid);
        if (!u || u.mtActive === 1 || now - p.at > PREDICT_MS) predicted.delete(uid);
    }

    // Drop any selected units that have despawned / left visibility.
    let pruned = false;
    for (const uid of selectedUids) {
        if (!latestUnits.has(uid)) { selectedUids.delete(uid); pruned = true; }
    }
    if (pruned) refreshCard();

    if (renderer) setRenderState(renderer, state);
    if (renderer) setSelectedUids(renderer, selectedUids);
    refreshStatus();   // keep the production progress bar / queued-step count live
}

// ── Networking: transfer the channel to the worker, else relay ───────────────────

function setupNet(dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";
    try {
        // Chromium fast path — the worker then owns send/recv directly.
        worker!.postMessage({ kind: "channel", channel: dc } satisfies MainToWorker,
                            [dc as unknown as Transferable]);
        console.info("net: transferred RTCDataChannel to worker");
    } catch {
        // Transferable RTCDataChannel unsupported — relay raw packets through us.
        relayChannel = dc;
        dc.addEventListener("message", (ev) => {
            if (ev.data instanceof ArrayBuffer)
                worker!.postMessage({ kind: "net-in", data: ev.data } satisfies MainToWorker, [ev.data]);
        });
        console.info("net: channel transfer unsupported — relaying packets via main thread");
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Identity travels in the box URL, so a box reloaded into its own popped-out tab is still pairable.
const role = (new URLSearchParams(location.search).get("role") as "host" | "peer") ?? "host";

console.info(`opening peer...  role=${role}`);
const { peer, selfId } = await openPeer();
console.info(`peer open  id=${selfId}`);

// Connection model: the host dials, the guest listens. The guest's listener is persistent (accepts
// the first connection AND every reconnect) and registered BEFORE we announce, so a dial can't beat
// it. A reconnect (the other box popped out + reloaded) just swaps the channel — see onConnection.
if (role === "peer") peer.on("connection", (conn) => conn.once("open", () => onConnection(conn)));

host.postMessage({ type: "peer-ready", role, selfId } satisfies PeerReadyMsg, "*");
console.info("announced peer-ready");

let started = false;

/** A data connection opened — initial pairing, or a reconnect after the other box popped out and
 *  reloaded. Boot the sim+render exactly once; hand the (new) channel to the worker every time, which
 *  re-attaches it. So a reconnect swaps the channel under a still-running sim — no restart. */
function onConnection(conn: DataConnection): void {
    console.info(`connection ${started ? "re-established (channel swap)" : "open"}  peer=${conn.peer}`);
    if (!started) { started = true; void boot(); }   // boot() creates the worker synchronously, before…
    setupNet(conn.dataChannel);                       // …setupNet transfers the channel to it
}

/** Host: (re)dial the guest on every `connect` from the harness. The dial can race a freshly-reloaded
 *  guest's listener, so retry a few times. */
async function dialGuest(targetId: string): Promise<void> {
    for (let attempt = 1; attempt <= 4; attempt++) {
        try { onConnection(await connectTo(peer, targetId)); return; }
        catch (err) { console.warn(`dial attempt ${attempt} failed, retrying…`, err); await new Promise((renderer) => setTimeout(renderer, 400)); }
    }
    console.error(`dial to ${targetId} gave up`);
}

/** Spawn the sim worker + start Phaser/input. Networking is handled by onConnection. */
async function boot(): Promise<void> {
    myTeam = role === "host" ? 0 : 1;
    selfRole = role;
    const isHost = role === "host";
    const sx = myTeam === 0 ? p0x : p1x;
    const sy = myTeam === 0 ? p0y : p1y;

    // Host spawns the authoritative referee worker (simulates both teams); the guest
    // spawns a thin client worker (relays over the channel — no local sim).
    // NOTE: each `new URL(...)` must take a *static string literal* — Vite's worker
    // bundler only rewrites/emits the worker chunk when the path is statically
    // analyzable. A ternary inside `new URL(...)` is silently left untransformed
    // (ships the raw `.ts` path → 404 at runtime), so branch at the Worker level.
    worker = isHost
        ? new Worker(new URL("../worker/referee.worker.ts", import.meta.url), { type: "module" })
        : new Worker(new URL("../worker/client.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = onWorkerMessage;

    // Relay this box's main-thread console to the debug server (→ get_console) via the worker, which holds
    // the debug WS.  Both host and peer workers connect now (wireBoxConsole + initDebugClient), so no gate.
    setConsoleSink((level, msg) => worker?.postMessage({ kind: "client-console", level, msg } satisfies MainToWorker));

    // The referee creates both teams' initial units; the guest worker ignores spawns.
    const spawns = isHost ? [
        { team: 0, sx: p0x, sy: p0y, count: SPAWN_COUNT, typeId: unitTypeId("unit-peasant") },
        { team: 1, sx: p1x, sy: p1y, count: SPAWN_COUNT, typeId: unitTypeId("unit-peon") },
    ] : [];
    worker.postMessage({
        kind: "init",
        init: { role, myTeam, seed: SEED, mapInfo, spawns, mapW: mapInfo.mapW, mapH: mapInfo.mapH },
    } satisfies MainToWorker);

    // Host-box restore (popped out / re-attached): replace the freshly-seeded world with the snapshot
    // the host page kept from before the reload, so the game resumes instead of starting over.
    if (isHost && pendingRestore) {
        worker.postMessage({ kind: "restore", snap: pendingRestore } satisfies MainToWorker);
        pendingRestore = null;
    }

    // ── Rendering + input ─────────────────────────────────────────────────────
    console.info("starting phaser...");
    renderer = await startPhaser(document.getElementById("game")!, { tilesetUrl, mapJson });
    console.info("phaser ready");

    renderer.myTeam = myTeam;
    renderer.scene.cameras.main.centerOn(sx * TILE_PX, sy * TILE_PX);

    cardController = createCommandCardController({
        getOwnSelection:    ownSelection,
        getRallyableBuildingUid: rallyableBuildingUid,
        snapToTile:         snapClickFP,
        emit:               emitCommand,
        render:             (card) => showCommandCard(renderer!, card),
        setTargetingCursor: (on) => setTargetingCursor(renderer!, on),
        log:                (m) => console.info(m),
        myTeam,
        fpToTile,
        canPlaceBuilding:   canPlaceBuildingLocal,
        showPlacementGhost: (g) => showPlacementGhost(renderer!, g),
    });

    setPrediction(renderer, predicted);   // share the live prediction map (we mutate it)

    renderer.onSelect = (uids) => {
        selectedUids = new Set(uids);
        setSelectedUids(renderer!, selectedUids);
        refreshCard();
    };

    // Raw input → the controller decides what it means.
    renderer.onSlot             = (index)             => cardController!.slot(index);
    renderer.onProductionCancel = (index)             => { const b = ownSelection()[0]; if (b !== undefined) emitCommand({ type: CmdType.CANCEL_PRODUCE, buildingUid: b, index, team: myTeam }); };
    renderer.onPrimaryClick     = (wxFP, wyFP)        => cardController!.primaryClick(wxFP, wyFP);
    renderer.onSecondaryClick   = (wxFP, wyFP, shift) => cardController!.secondaryClick(wxFP, wyFP, shift);
    renderer.onEscape         = ()           => cardController!.escape();
    renderer.onHotkey         = (letter)     => cardController!.hotkey(letter);
    renderer.onHover          = (wxFP, wyFP) => cardController!.hoverTile(wxFP, wyFP);

    console.info(`${role} client ready`);
    // Tell the host the renderer is up (so a windowed box can now minimize safely —
    // booting while minimized would init the canvas at 0×0).
    host.postMessage({ type: "client-ready", role } satisfies ClientReadyMsg, "*");
}

// ── Parent messages ───────────────────────────────────────────────────────────

window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data;
    if (!d) return;

    // Host only: (re)dial the guest. Sent on first pairing and again on every reconnect.
    if (d.type === "connect" && role === "host") {
        void dialGuest((d as ConnectMsg).targetId);
    }

    // Host only: a snapshot to resume from when this (reloaded) host box boots — sent before connect.
    if (d.type === "restore" && role === "host") {
        pendingRestore = d.snap as WorldSnapshot;
        console.info(`[box] host restore received — snapshot tick=${pendingRestore.tick}`);
    }

    if (d.type === "spawn" && worker) {
        // Ask the referee to spawn one of our units at a random position (referee mints the id).
        const mapW = mapInfo.mapW, mapH = mapInfo.mapH;
        const cmd: SpawnCmd = {
            type:   CmdType.SPAWN,
            xFP:    tileCenterFP((Math.random() * (mapW - 4) + 2) | 0),
            yFP:    tileCenterFP((Math.random() * (mapH - 4) + 2) | 0),
            team:   myTeam,
            typeId: unitTypeId(myTeam === 0 ? "unit-peasant" : "unit-peon"),
        };
        worker.postMessage({ kind: "command", cmd } satisfies MainToWorker);
    }

    if (d.type === "speed" && worker) requestSpeed(Number(d.speed) || 1);

    // Step debugger: control messages from the host page (relayed from the VS Code adapter) →
    // this box's worker. The payload is a MainToWorker debug message (pause/resume/step/state).
    if (d.type === "sim-debug-control" && worker) worker.postMessage(d.msg as MainToWorker);
});
