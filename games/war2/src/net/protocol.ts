/**
 * Wire protocol (host-authoritative model).
 *
 * Two packet types ride the data channel between a client and the referee:
 *   • CLIENT_COMMAND — client → referee: the player's intents for a tick.
 *   • STATE_UPDATE   — referee → client: that client's authoritative *fog view*
 *                      (its own units + enemies currently in its sight), produced
 *                      per-recipient so unseen enemy state never crosses the wire.
 *
 * Both are JSON, framed with a 1-byte type + 4-byte LE length prefix:
 *   [1] type   [4] json-byte-length (uint32 LE)   [n] UTF-8 JSON
 *
 * The host's own client reaches the referee in-process (postMessage); only the
 * remote client uses these wire packets.  See net/transport.ts for the seam.
 */
import type { UnitSnapshot } from "../game/types";
export type { UnitSnapshot };

export const enum PacketType { STATE_UPDATE = 5, CLIENT_COMMAND = 6 }
export const enum CmdType    { MOVE = 1, SPAWN = 2, STOP = 3, BUILD = 4, SPEED = 5, PRODUCE = 6, SET_RALLY = 7, CANCEL_PRODUCE = 8 }

// Commands are intents.  The referee assigns unit ids for SPAWN/BUILD (clients no
// longer mint them); `team` is the issuing client's team and is validated/stamped
// by the referee.
// `queue` (MOVE/STOP): true = append to the unit's action queue (shift-click); absent/false = replace
// the current order and clear the queue.  See game/orders.ts (enqueueOrder / advanceOrderQueues).
export interface MoveCmd  { type: CmdType.MOVE;  unitIds: number[]; txFP: number; tyFP: number; queue?: boolean; }
export interface SpawnCmd { type: CmdType.SPAWN; xFP: number; yFP: number; team: number; typeId: number; }
export interface StopCmd  { type: CmdType.STOP;  unitIds: number[]; queue?: boolean; }
export interface BuildCmd { type: CmdType.BUILD; typeId: number; team: number; tileX: number; tileY: number; }
// Control-plane (not a world mutation): requests the *authoritative* game-speed multiplier. The
// referee applies + broadcasts it (StateUpdatePayload.speed); it never reaches applyCommands.
export interface SpeedCmd { type: CmdType.SPEED; speed: number; }
// Building production queue (see game/production.ts).  PRODUCE enqueues a product (a trainable unit
// typeId) at a building; CANCEL_PRODUCE drops the queue item at `index`; SET_RALLY points freshly
// trained units at a destination.  `buildingUid` is the building's stable UnitId.
export interface ProduceCmd       { type: CmdType.PRODUCE;        buildingUid: number; productTypeId: number; team: number; }
export interface CancelProduceCmd { type: CmdType.CANCEL_PRODUCE; buildingUid: number; index: number; team: number; }
export interface SetRallyCmd      { type: CmdType.SET_RALLY;      buildingUid: number; txFP: number; tyFP: number; team: number; }
export type Command = MoveCmd | SpawnCmd | StopCmd | BuildCmd | SpeedCmd | ProduceCmd | CancelProduceCmd | SetRallyCmd;

// ── Packet payloads ─────────────────────────────────────────────────────────────

/** referee → client: the recipient's authoritative fog view this tick.
 *  Delta-encoded over the wire: a keyframe carries the full visible set; a delta
 *  carries only changed/new units + the uids that dropped out (left sight / died). */
export interface StateUpdatePayload {
    tick:          number;
    keyframe:      boolean;         // true = visibleStates is the complete visible set
    visibleStates: UnitSnapshot[];  // full set (keyframe) or changed/new units (delta)
    removed:       number[];         // uids that left the recipient's view (delta only; [] on keyframe)
    pingTs:        number;
    speed:         number;          // authoritative game-speed multiplier (referee → clients)
}

/** True if any wire-relevant field of two snapshots of the same unit differs. */
export function unitSnapshotChanged(a: UnitSnapshot, b: UnitSnapshot): boolean {
    return a.x !== b.x || a.y !== b.y || a.dir !== b.dir || a.moving !== b.moving
        || a.moveActive !== b.moveActive || a.mtx !== b.mtx || a.mty !== b.mty
        || a.curTx !== b.curTx || a.curTy !== b.curTy
        || a.goalTx !== b.goalTx || a.goalTy !== b.goalTy || a.pathActive !== b.pathActive
        || a.type !== b.type || a.team !== b.team
        || a.bw !== b.bw || a.bh !== b.bh || a.buildLeft !== b.buildLeft
        // Queue state (HUD): production countdown ticks every tick while busy; queue/order length and the
        // rally point change on enqueue/cancel/complete.  Length+head is enough (items only push/shift).
        || (a.prod?.ticksLeft ?? -1) !== (b.prod?.ticksLeft ?? -1)
        || (a.prod?.queue.length ?? 0) !== (b.prod?.queue.length ?? 0)
        || (a.orders?.length ?? 0) !== (b.orders?.length ?? 0)
        || (a.rally?.txFP ?? -1) !== (b.rally?.txFP ?? -1)
        || (a.rally?.tyFP ?? -1) !== (b.rally?.tyFP ?? -1);
}

/** client → referee: the player's commands for this tick. */
export interface ClientCommandPayload {
    cmds:   Command[];
    pingTs: number;   // echoed back in the next STATE_UPDATE for RTT
}

// ── Framing ───────────────────────────────────────────────────────────────────

function framePacket(type: PacketType, payload: unknown): ArrayBuffer {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const buf   = new ArrayBuffer(1 + 4 + bytes.byteLength);
    const dv    = new DataView(buf);
    dv.setUint8(0,  type);
    dv.setUint32(1, bytes.byteLength, true);
    new Uint8Array(buf, 5).set(bytes);
    return buf;
}

function unframe<T>(buf: ArrayBuffer): T {
    const len   = new DataView(buf).getUint32(1, true);
    const bytes = new Uint8Array(buf, 5, len);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** Packet type byte — dispatch before decoding the body. */
export function packetType(buf: ArrayBuffer): number { return new DataView(buf).getUint8(0); }

export const encodeStateUpdate    = (p: StateUpdatePayload): ArrayBuffer    => framePacket(PacketType.STATE_UPDATE, p);
export const decodeStateUpdate    = (b: ArrayBuffer): StateUpdatePayload    => unframe<StateUpdatePayload>(b);
export const encodeClientCommand  = (p: ClientCommandPayload): ArrayBuffer  => framePacket(PacketType.CLIENT_COMMAND, p);
export const decodeClientCommand  = (b: ArrayBuffer): ClientCommandPayload  => unframe<ClientCommandPayload>(b);
