/**
 * Client — runs in each iframe.
 *
 * Partial-sim model (fog-of-war with hidden information):
 *   • Each peer simulates only its OWN units.
 *   • Enemy units are represented as display-only entities, spawned / updated /
 *     despawned from STATE_UPDATE snapshots pushed by the owning peer each tick.
 *   • Commands are applied locally the tick they are issued (no echo delay).
 *   • The cross-peer hash check is gone; sims legitimately differ.
 *
 * Commitment scheme:
 *   • Each tick we compute commitHash = fnv1a(nonce ⊕ own hidden unit positions).
 *   • The opponent stores this; when a unit exits fog the owner sends the nonce
 *     so the receiver can verify the unit's position was committed before it was
 *     visible (retroactive-lie prevention).
 *
 * Unit ID spaces:
 *   • Team 0 → IDs 1 … 0x7FFFFFFF
 *   • Team 1 → IDs 0x80000001 … 0xFFFFFFFF
 *   Guarantees no collision when enemy units arrive via STATE_UPDATE.
 */
import { createGame }                                      from "../game/game";
import type { MapInfo }                                    from "../game/game";
import { Unit, UnitId }                                    from "../game/components";
import { unitTypeId, unitTypeName }                        from "../game/unitTypes";
import { createCommandCardController }                     from "./commandCardController";
import { FP, TICK_MS, TILE_PX, tileCenterFP, fpToTile }   from "../game/components";
import mapJson                                             from "../assets/maps/ladder/Plains of snow BNE.json";
import tilesetUrl                                          from "../assets/tilesets/winter.png";
import terrainData                                         from "../assets/terrain.json";
import {
    encodeStateUpdate, decodeStateUpdate,
    PacketType, CmdType,
    type Command, type SpawnCmd, type UnitSnapshot,
} from "../net/protocol";
import { openPeer, connectTo, waitForConnection, type Transport } from "../net/peer";
import { startPhaser } from "../render/renderer";
import type { HudData } from "../render/renderer";
import { initDebugClient, sendDebugState, sendDebugCommands, setDebugCallbacks } from "../debug/client";
import { initGameConsole } from "../debug/console";
import type { PeerReadyMsg, InitMsg } from "harness/client";

// In-game console (press ` / ~). Set up first so it captures everything below,
// including console output and uncaught errors from imported modules.
initGameConsole();

// ── Logger ────────────────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";
function log(level: LogLevel, msg: string): void {
    // Route through console so it lands in both the in-game console and DevTools.
    console[level](msg);
}

// ── Map helpers ───────────────────────────────────────────────────────────────

function mapProp<T>(name: string, fallback: T): T {
    const props = (mapJson as any).properties as Array<{ name: string; value: unknown }> | undefined;
    const p = props?.find(q => q.name === name);
    return p !== undefined ? (p.value as T) : fallback;
}

function snapToTileCenter(fp: number): number {
    return tileCenterFP(fpToTile(fp));
}

// ── Game ──────────────────────────────────────────────────────────────────────

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

const game = createGame(SEED, mapInfo);

const p0x = mapProp("p0_startX", 32), p0y = mapProp("p0_startY", 32);
const p1x = mapProp("p1_startX", 96), p1y = mapProp("p1_startY", 96);

// ── Runtime state ─────────────────────────────────────────────────────────────

let role:      "host" | "peer" = "host";
let myTeam:    number = 0;
let oppTeam:   number = 1;
let transport: Transport | null = null;
let simPaused  = false;

const hud: HudData = {
    serverTick: 0, clientTick: 0, rtt: 0, lead: 0,
    lastHash: 0, beatAge: 0,
};

const selectedEids = new Set<number>();
const pendingCmds: Command[] = [];

// ── Known enemy units (display-only, from STATE_UPDATE) ───────────────────────

const knownEnemyUids = new Set<number>();

// ── Commitment scheme ─────────────────────────────────────────────────────────
// myCommits: tick → {nonce, hash}  — kept locally, revealed on unit exit
// oppCommits: tick → commitHash    — received from opponent, verified on reveal

const COMMIT_CAP = 600; // keep 30 s of history at 20 TPS
const myCommits  = new Map<number, { nonce: number; hash: number }>();
const oppCommits = new Map<number, number>();

function storeBounded<V>(map: Map<number, V>, tick: number, value: V): void {
    map.set(tick, value);
    if (map.size > COMMIT_CAP) map.delete(tick - COMMIT_CAP);
}

// ── Ping helpers ──────────────────────────────────────────────────────────────

let lastPingTick = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(pkt: ArrayBuffer): void { transport?.send(pkt); }

// ── Tick loop (runs on BOTH host and peer) ────────────────────────────────────

function tick(): void {
    if (simPaused) return;

    // Apply own commands and advance own sim
    const myCmds = pendingCmds.splice(0);
    game.applyCommands(myCmds);
    game.step();
    sendDebugCommands(role, game.world.tick, myCmds);
    sendDebugState(game.world, game.hashOwn(myTeam), role);

    // Compute what the opponent can see (based on known opp units in our sim)
    const visibleToOpp = game.computeVisibleUids(oppTeam);

    // Generate per-tick commitment over hidden own-unit positions
    const nonce      = (Math.random() * 0xFFFF_FFFF) | 0;
    const commitHash = game.hiddenUnitsHash(myTeam, nonce, visibleToOpp);
    storeBounded(myCommits, game.world.tick, { nonce, hash: commitHash });

    // Build the outgoing STATE_UPDATE
    const visibleStates = game.ownSnapshotsVisibleTo(myTeam);
    const filteredCmds  = myCmds.filter(cmd =>
        cmd.type !== CmdType.MOVE || cmd.unitIds.some(uid => visibleToOpp.has(uid)),
    );

    hud.clientTick = game.world.tick;
    hud.serverTick = game.world.tick;
    hud.lastHash   = game.hashOwn(myTeam);

    if (!transport) return;

    // Measure ping every 10 ticks
    let pingTs = 0;
    if (game.world.tick - lastPingTick >= 10) {
        pingTs       = performance.now();
        lastPingTick = game.world.tick;
    }

    send(encodeStateUpdate({
        tick:          game.world.tick,
        visibleStates,
        commands:      filteredCmds,
        commitHash,
        pingTs,
    }));
}

// ── Receive ───────────────────────────────────────────────────────────────────

function onData(data: ArrayBuffer): void {
    hud.beatAge = 0;

    const type = new DataView(data).getUint8(0);
    if (type !== PacketType.STATE_UPDATE) return;

    const payload = decodeStateUpdate(data);

    if (payload.pingTs > 0) {
        hud.rtt = Math.round(performance.now() - payload.pingTs);
    }

    hud.serverTick = payload.tick;

    // Store opponent's commitment for future reveal verification
    storeBounded(oppCommits, payload.tick, payload.commitHash);

    // Apply received enemy unit states (spawn / update / despawn)
    applyEnemyStateUpdate(payload.visibleStates);
}

// ── Enemy state management ────────────────────────────────────────────────────

function applyEnemyStateUpdate(visibleStates: UnitSnapshot[]): void {
    // Only accept units genuinely within our own sight range.
    // The sender pushes all their units; we filter here so a cheating sender
    // can't force-spawn units at arbitrary positions in our sim.
    // Single pass: filter + build incoming set simultaneously.
    const inSight: UnitSnapshot[] = [];
    const incoming = new Set<number>();
    for (const s of visibleStates) {
        if (game.isTileVisible(myTeam, s.curTx, s.curTy)) {
            inSight.push(s);
            incoming.add(s.uid);
        }
    }

    // Despawn units that dropped out of visibility
    for (const uid of knownEnemyUids) {
        if (!incoming.has(uid)) {
            const eid = game.eidForUnitId(uid);
            if (eid !== undefined) {
                selectedEids.delete(eid);
                Unit.selected[eid] = 0;
                game.removeKnownUnit(eid);
            }
            knownEnemyUids.delete(uid);
        }
    }

    // Spawn or refresh units that are currently visible
    for (const snap of inSight) {
        if (knownEnemyUids.has(snap.uid)) {
            const eid = game.eidForUnitId(snap.uid);
            if (eid !== undefined) game.updateKnownUnit(eid, snap);
        } else {
            game.addKnownUnit(snap);
            knownEnemyUids.add(snap.uid);
        }
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

log("info", "opening peer...");
const { peer: peerInstance, selfId } = await openPeer();
log("info", `peer open  id=${selfId}`);
window.parent.postMessage({ type: "peer-ready", selfId } satisfies PeerReadyMsg, "*");
log("info", "signalled parent, waiting for init...");

async function start(initRole: "host" | "peer", targetId: string): Promise<void> {
    role    = initRole;
    myTeam  = role === "host" ? 0 : 1;
    oppTeam = 1 - myTeam;

    log("info", `init received  role=${role}  target=${targetId}`);

    // Initialise unit-ID counter for our team's ID space
    game.initUnitIdCounter(myTeam);

    // Spawn only our own team's units
    const sx = myTeam === 0 ? p0x : p1x;
    const sy = myTeam === 0 ? p0y : p1y;
    const workerType = unitTypeId(myTeam === 0 ? "unit-peasant" : "unit-peon");
    for (let i = 0; i < 4; i++) {
        game.spawnUnit(
            tileCenterFP(sx + (i % 2)),
            tileCenterFP(sy + Math.floor(i / 2)),
            myTeam,
            undefined,
            workerType,
        );
    }

    // Connect
    if (role === "host") {
        log("info", `connecting to ${targetId}...`);
        transport = await connectTo(peerInstance, targetId);
    } else {
        log("info", "waiting for host connection...");
        transport = await waitForConnection(peerInstance);
    }

    log("info", `transport open  peer=${transport.peerId}`);
    initDebugClient(role);
    setDebugCallbacks({
        onPause:  () => { simPaused = true;  log("info", "sim paused by observer"); },
        onResume: () => { simPaused = false; log("info", "sim resumed by observer"); },
    });
    transport.onData = onData;

    log("info", "starting phaser...");
    const scene = await startPhaser(document.getElementById("game")!, { tilesetUrl, mapJson });
    log("info", "phaser ready");

    scene.getUnitEids = () => game.unitEids();
    scene.hud         = hud;
    scene.myTeam      = myTeam;

    // Centre camera on own spawn
    scene.cameras.main.centerOn(sx * TILE_PX, sy * TILE_PX);

    // Single owner of command-card interaction state (selection type / page / armed).
    const cardController = createCommandCardController({
        getOwnSelection:    () => [...selectedEids].filter(e => Unit.team[e] === myTeam),
        unitIdOf:           (eid) => UnitId.id[eid],
        previewMove:        (eid, x, y) => game.previewMoveTarget(eid, x, y),
        snapToTile:         snapToTileCenter,
        emit:               (cmd) => { pendingCmds.push(cmd); },
        render:             (card) => scene.showCommandCard(card),
        setTargetingCursor: (on) => scene.setTargetingCursor(on),
        log:                (m) => log("info", m),
        myTeam,
        consumeUnitId:      () => game.consumeUnitId(),
        fpToTile,
        canPlaceBuilding:   (tx, ty, typeId) => game.canPlaceBuilding(tx, ty, typeId),
        showPlacementGhost: (g) => scene.showPlacementGhost(g),
    });

    // Recompute the card from the current selection (primary = first own unit).
    const refreshCard = () => {
        const primary = [...selectedEids].find(e => Unit.team[e] === myTeam);
        cardController.setSelection(primary !== undefined ? unitTypeName(Unit.type[primary]) : null);
    };

    game.registerObservers({
        onSpawn: (eid) => {
            console.debug(`[obs] unit spawned eid=${eid} uid=${UnitId.id[eid]} team=${Unit.team[eid]}`);
        },
        onDespawn: (eid) => {
            const wasSelected = selectedEids.delete(eid);
            knownEnemyUids.delete(UnitId.id[eid]);
            Unit.selected[eid] = 0;
            if (wasSelected) refreshCard();
        },
    });

    scene.onSelect = (eids) => {
        for (const eid of game.unitEids()) Unit.selected[eid] = 0;
        for (const eid of eids)            Unit.selected[eid] = 1;
        selectedEids.clear();
        eids.forEach(e => selectedEids.add(e));
        refreshCard();
    };

    // Raw input → the controller decides what it means.
    scene.onSlot           = (index)      => cardController.slot(index);
    scene.onPrimaryClick   = (wxFP, wyFP) => cardController.primaryClick(wxFP, wyFP);
    scene.onSecondaryClick = (wxFP, wyFP) => cardController.secondaryClick(wxFP, wyFP);
    scene.onEscape         = ()           => cardController.escape();
    scene.onHover          = (wxFP, wyFP) => cardController.hoverTile(wxFP, wyFP);

    // Tick loop — both host and peer tick independently at 20 TPS
    setInterval(tick, TICK_MS);

    // Beat-age counter (detect loss of connectivity); reset to 0 in onData
    setInterval(() => {
        hud.beatAge++;
        hud.lead = 0; // no lead concept in partial-sim model
    }, TICK_MS);

    log("info", `${role} tick loop started`);
}

// ── Parent messages ───────────────────────────────────────────────────────────

window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data;
    if (!d) return;

    if (d.type === "init") {
        const init = d as InitMsg;
        start(init.role, init.targetId);
    }

    if (d.type === "spawn") {
        // Each peer spawns only their own team's unit.
        // Both iframes receive the same "spawn" message from the parent, so
        // each side independently spawns one unit for their own team.
        const unitId = game.consumeUnitId();
        const mapW   = (mapJson as any).width  as number;
        const mapH   = (mapJson as any).height as number;
        pendingCmds.push({
            type:   CmdType.SPAWN,
            unitId,
            xFP:    tileCenterFP((Math.random() * (mapW - 4) + 2) | 0),
            yFP:    tileCenterFP((Math.random() * (mapH - 4) + 2) | 0),
            team:   myTeam,
            typeId: unitTypeId(myTeam === 0 ? "unit-peasant" : "unit-peon"),
        } satisfies SpawnCmd);
        log("info", `spawn queued  uid=${unitId} team=${myTeam}`);
    }
});
