/**
 * Referee worker (host only) — the single authoritative simulation.
 *
 * Runs the deterministic sim of BOTH teams, applies each client's validated
 * commands, and sends every client only its own *fog view* (own units + enemies
 * currently in its sight).  Because the referee holds all positions it can do the
 * per-recipient visibility filtering that a P2P peer never could — so unseen enemy
 * state never crosses the wire (genuine fog), and because it is the sole creator /
 * mover of units, a client cannot fabricate units, teleport, or cheat the economy.
 *
 * Clients reach the referee through net/transport.ts: the host plays in-process
 * (LocalRefereeClient over postMessage); the guest is a RemoteRefereeClient over
 * the data channel.  Lifting this to a neutral server makes the host remote too,
 * with no change here.
 *
 * Runs in a Worker so it keeps simulating when the host's tab is backgrounded.
 */
import { createGame, type GameInstance, type MapInfo } from "../game/game";
import { validateCommand } from "../game/validate";
import { UnitId, TICK_MS, tileCenterFP } from "../game/components";
import { CmdType, type Command, type UnitSnapshot, type StateUpdatePayload } from "../net/protocol";
import { LocalRefereeClient, RemoteRefereeClient, type RefereeClient } from "../net/transport";
import { getPassability } from "../game/passability";
import { initDebugClient, sendDebugState, sendDebugCommands, setDebugCallbacks } from "../debug/client";
import {
    renderUnitFromSnapshot,
    type MainToWorker, type WorkerToMain, type RenderState, type RenderHud, type WorkerInit,
} from "./ipc";

const post = (msg: WorkerToMain, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);

// ── Runtime state ─────────────────────────────────────────────────────────────

let game!: GameInstance;
let myTeam   = 0;          // the host's team
let oppTeam  = 1;          // the guest's team
let mapW = 0, mapH = 0;
let simPaused = false;
let started   = false;

const hud: RenderHud = { serverTick: 0, clientTick: 0, rtt: 0, lead: 0, lastHash: 0, beatAge: 0 };

// ── Clients ───────────────────────────────────────────────────────────────────
// The host's in-process client is always present; the guest joins when its channel
// arrives.  Each client's commands accumulate in a buffer drained every tick.

let hostClient!: LocalRefereeClient;
let guestClient: RemoteRefereeClient | null = null;
const pending = new Map<RefereeClient, Command[]>();
const lastPing = new Map<RefereeClient, number>();

/** Stamp create-commands with the issuing client's team (the authoritative source). */
function stampTeam(cmd: Command, team: number): Command {
    if (cmd.type === CmdType.SPAWN || cmd.type === CmdType.BUILD) return { ...cmd, team };
    return cmd;
}

function registerClient(c: RefereeClient): void {
    pending.set(c, []);
    c.onCommand = (cmds, pingTs) => {
        const buf = pending.get(c)!;
        for (const cmd of cmds) buf.push(stampTeam(cmd, c.team));
        if (pingTs) lastPing.set(c, pingTs);
    };
}

function clients(): RefereeClient[] {
    return guestClient ? [hostClient, guestClient] : [hostClient];
}

/** Units visible to `team`: its own units + enemy units currently in its sight. */
function fogSnapshot(team: number): UnitSnapshot[] {
    const visible = game.computeVisibleUids(team);
    const out: UnitSnapshot[] = [];
    for (const eid of game.unitEids()) {
        if (visible.has(UnitId.id[eid])) out.push(game.snapshotUnit(eid));
    }
    return out;
}

function toRenderState(payload: StateUpdatePayload): RenderState {
    return { tick: payload.tick, hud: { ...hud }, units: payload.visibleStates.map(renderUnitFromSnapshot) };
}

// ── Networking (guest channel: transferred, else relayed through host main) ──────

let channel: RTCDataChannel | null = null;

function attachGuestChannel(ch: RTCDataChannel): void {
    channel = ch;
    channel.binaryType = "arraybuffer";
    guestClient = new RemoteRefereeClient(oppTeam, (ab) => {
        if (channel && channel.readyState === "open") channel.send(ab);
    });
    registerClient(guestClient);
    channel.onmessage = (ev) => { if (ev.data instanceof ArrayBuffer) guestClient!.handleBytes(ev.data); };
}

function attachGuestRelay(): void {
    if (guestClient) return;
    guestClient = new RemoteRefereeClient(oppTeam, (ab) => post({ kind: "net-out", data: ab }, [ab]));
    registerClient(guestClient);
}

// ── Tick loop ─────────────────────────────────────────────────────────────────

function tick(): void {
    if (simPaused || !started) return;

    // Validate then apply each client's commands (host first, then guest), then step.
    const applied: Command[] = [];
    for (const c of clients()) {
        const buf = pending.get(c)!.splice(0);
        if (!buf.length) continue;
        const valid = buf.filter(cmd => {
            const ok = validateCommand(game.world, c.team, cmd);
            if (!ok) console.warn(`[referee] rejected illegal command from team ${c.team}`, cmd);
            return ok;
        });
        if (valid.length) { applied.push(...valid); game.applyCommands(valid); }
    }
    game.step();

    sendDebugCommands("host", game.world.tick, applied);
    sendDebugState(game.world, game.hashOwn(myTeam), "host");

    hud.clientTick = hud.serverTick = game.world.tick;
    hud.lastHash   = game.hashOwn(myTeam);

    // Send each client its fog view (the client formats it — full for the host,
    // delta-encoded for the remote guest).
    for (const c of clients()) {
        c.sendSnapshot(game.world.tick, fogSnapshot(c.team), lastPing.get(c) ?? 0);
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function start(init: WorkerInit): void {
    myTeam  = init.myTeam;          // host
    oppTeam = 1 - myTeam;
    mapW    = init.mapW;
    mapH    = init.mapH;

    game = createGame(init.seed, init.mapInfo satisfies MapInfo);
    game.initUnitIdCounter(0);      // single id space — the referee mints every unit

    for (const s of init.spawns) {
        for (let i = 0; i < s.count; i++) {
            game.spawnUnit(tileCenterFP(s.sx + (i % 2)), tileCenterFP(s.sy + Math.floor(i / 2)), s.team, undefined, s.typeId);
        }
    }

    // Host plays in-process: its snapshot becomes a render message; its commands
    // arrive via the "command" message pump (see deliverCommands below).
    hostClient = new LocalRefereeClient(myTeam, (payload) => post({ kind: "render", state: toRenderState(payload) }));
    registerClient(hostClient);

    initDebugClient("host");
    setDebugCallbacks({
        onPause:          () => { simPaused = true;  },
        onResume:         () => { simPaused = false; },
        onInspectorCount: (n) => post({ kind: "inspector-count", n }),
    });

    started = true;
    post({ kind: "ready", passability: getPassability(), mapW, mapH });

    setInterval(tick, TICK_MS);
    setInterval(() => { hud.beatAge++; hud.lead = 0; }, TICK_MS);
}

// ── Message pump ────────────────────────────────────────────────────────────────

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
    const msg = ev.data;
    switch (msg.kind) {
        case "init":    start(msg.init); break;
        case "channel": attachGuestChannel(msg.channel); break;
        case "net-in":  attachGuestRelay(); guestClient!.handleBytes(msg.data); break;
        case "command": hostClient.deliverCommands([msg.cmd], 0); break;
        case "pause":   simPaused = true;  break;
        case "resume":  simPaused = false; break;
    }
};
