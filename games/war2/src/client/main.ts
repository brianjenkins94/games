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
import { FP, TILE_PX, tileCenterFP, fpToTile } from "../game/components";
import { unitTypeId, unitTypeName, unitFootprint } from "../game/unitTypes";
import mapJson from "../assets/maps/ladder/Plains of snow BNE.json";
import tilesetUrl from "../assets/tilesets/winter.png";
import terrainData from "../assets/terrain.json";
import { CmdType, type Command, type SpawnCmd } from "../net/protocol";
import { openPeer, connectTo, waitForConnection } from "../net/peer";
import { startPhaser, type GameScene, type UnitPrediction } from "../render/renderer";
import { initGameConsole } from "../debug/console";
import type { MainToWorker, WorkerToMain, RenderState, RenderUnit } from "../worker/ipc";
import type { MapInfo } from "../game/world";
import type { PeerReadyMsg, InitMsg } from "harness/client";

// In-game console (press ` / ~). Set up first so it captures everything below.
initGameConsole();

// ── Map config ──────────────────────────────────────────────────────────────────

function mapProp<T>(name: string, fallback: T): T {
    const props = (mapJson as any).properties as Array<{ name: string; value: unknown }> | undefined;
    const p = props?.find(q => q.name === name);
    return p !== undefined ? (p.value as T) : fallback;
}

function snapToTileCenter(fp: number): number {
    return tileCenterFP(fpToTile(fp));
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

// ── Runtime state ─────────────────────────────────────────────────────────────

let myTeam  = 0;
let worker: Worker | null = null;
let scene:  GameScene | null = null;
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

// ── Worker messages ─────────────────────────────────────────────────────────────

function onWorkerMessage(ev: MessageEvent<WorkerToMain>): void {
    const msg = ev.data;
    switch (msg.kind) {
        case "ready":
            passability = msg.passability;
            mapTW = msg.mapW; mapTH = msg.mapH;
            break;
        case "render":          onRender(msg.state); break;
        case "net-out":         relayChannel?.send(msg.data); break;   // relay mode
        case "inspector-count": updateInspectorBadge(msg.n); break;
    }
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

    scene?.setRenderState(state);
    scene?.setSelectedUids(selectedUids);
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

console.info("opening peer...");
const { peer, selfId } = await openPeer();
console.info(`peer open  id=${selfId}`);
window.parent.postMessage({ type: "peer-ready", selfId } satisfies PeerReadyMsg, "*");
console.info("signalled parent, waiting for init...");

async function start(role: "host" | "peer", targetId: string): Promise<void> {
    myTeam = role === "host" ? 0 : 1;
    const isHost = role === "host";
    const sx = myTeam === 0 ? p0x : p1x;
    const sy = myTeam === 0 ? p0y : p1y;

    console.info(`init received  role=${role}  target=${targetId}`);

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

    // The referee creates both teams' initial units; the guest worker ignores spawns.
    const spawns = isHost ? [
        { team: 0, sx: p0x, sy: p0y, count: SPAWN_COUNT, typeId: unitTypeId("unit-peasant") },
        { team: 1, sx: p1x, sy: p1y, count: SPAWN_COUNT, typeId: unitTypeId("unit-peon") },
    ] : [];
    worker.postMessage({
        kind: "init",
        init: { role, myTeam, seed: SEED, mapInfo, spawns, mapW: mapInfo.mapW, mapH: mapInfo.mapH },
    } satisfies MainToWorker);

    // Establish the peer connection, then hand its channel to the worker.
    console.info(role === "host" ? `connecting to ${targetId}...` : "waiting for host connection...");
    const conn = role === "host" ? await connectTo(peer, targetId) : await waitForConnection(peer);
    console.info(`connection open  peer=${conn.peer}`);
    setupNet(conn.dataChannel);

    // ── Rendering + input ─────────────────────────────────────────────────────
    console.info("starting phaser...");
    scene = await startPhaser(document.getElementById("game")!, { tilesetUrl, mapJson });
    console.info("phaser ready");

    scene.myTeam = myTeam;
    scene.cameras.main.centerOn(sx * TILE_PX, sy * TILE_PX);

    cardController = createCommandCardController({
        getOwnSelection:    ownSelection,
        snapToTile:         snapToTileCenter,
        emit:               emitCommand,
        render:             (card) => scene!.showCommandCard(card),
        setTargetingCursor: (on) => scene!.setTargetingCursor(on),
        log:                (m) => console.info(m),
        myTeam,
        fpToTile,
        canPlaceBuilding:   canPlaceBuildingLocal,
        showPlacementGhost: (g) => scene!.showPlacementGhost(g),
    });

    scene.setPrediction(predicted);   // share the live prediction map (we mutate it)

    scene.onSelect = (uids) => {
        selectedUids = new Set(uids);
        scene!.setSelectedUids(selectedUids);
        refreshCard();
    };

    // Raw input → the controller decides what it means.
    scene.onSlot           = (index)      => cardController!.slot(index);
    scene.onPrimaryClick   = (wxFP, wyFP) => cardController!.primaryClick(wxFP, wyFP);
    scene.onSecondaryClick = (wxFP, wyFP) => cardController!.secondaryClick(wxFP, wyFP);
    scene.onEscape         = ()           => cardController!.escape();
    scene.onHotkey         = (letter)     => cardController!.hotkey(letter);
    scene.onHover          = (wxFP, wyFP) => cardController!.hoverTile(wxFP, wyFP);

    console.info(`${role} client ready`);
}

// ── Parent messages ───────────────────────────────────────────────────────────

window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data;
    if (!d) return;

    if (d.type === "init") {
        const init = d as InitMsg;
        start(init.role, init.targetId);
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
});
