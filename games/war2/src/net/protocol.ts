/**
 * Wire protocol (partial-sim model).
 *
 * The only packet type is STATE_UPDATE, sent by each peer every tick.  It is
 * JSON-encoded and framed with a 1-byte type + 4-byte length prefix:
 *   [1]  type   = PacketType.STATE_UPDATE
 *   [4]  length of JSON bytes (uint32 LE)
 *   [n]  UTF-8 JSON  (StateUpdatePayload)
 *
 * Each update carries the states of own units currently visible to the opponent,
 * own-team commands filtered to those visible units (for future cryptographic
 * audit — not re-applied to the sim), a commitment hash over hidden own-unit
 * positions, and a ping timestamp.  The receiver uses the snapshots to maintain
 * a display-only set of known enemy entities.
 *
 * The earlier lockstep model (binary CMD_BATCH / ACK packets, cross-peer hash
 * checks, and snapshot+command-log reconciliation) has been removed.
 */
import type { UnitSnapshot } from "../game/types";
export type { UnitSnapshot };

export const enum PacketType { STATE_UPDATE = 5 }
export const enum CmdType    { MOVE = 1, SPAWN = 2, STOP = 3, BUILD = 4 }

export interface MoveCmd  { type: CmdType.MOVE;  unitIds: number[]; txFP: number; tyFP: number; }
export interface SpawnCmd { type: CmdType.SPAWN; unitId:  number;   xFP:  number; yFP:  number; team: number; typeId: number; }
export interface StopCmd  { type: CmdType.STOP;  unitIds: number[]; }
export interface BuildCmd { type: CmdType.BUILD; unitId:  number;   typeId: number; team: number; tileX: number; tileY: number; }
export type Command = MoveCmd | SpawnCmd | StopCmd | BuildCmd;

// ── STATE_UPDATE packet ───────────────────────────────────────────────────────

export interface StateUpdatePayload {
    tick:          number;
    visibleStates: UnitSnapshot[];  // own units visible to recipient this tick
    commands:      Command[];        // own commands filtered to visible units (audit only)
    commitHash:    number;           // fnv1a(nonce ⊕ hidden own-unit positions)
    pingTs:        number;
}

export function encodeStateUpdate(p: StateUpdatePayload): ArrayBuffer {
    const bytes = new TextEncoder().encode(JSON.stringify(p));
    const buf   = new ArrayBuffer(1 + 4 + bytes.byteLength);
    const dv    = new DataView(buf);
    dv.setUint8(0,  PacketType.STATE_UPDATE);
    dv.setUint32(1, bytes.byteLength, true);
    new Uint8Array(buf, 5).set(bytes);
    return buf;
}

export function decodeStateUpdate(buf: ArrayBuffer): StateUpdatePayload {
    const len   = new DataView(buf).getUint32(1, true);
    const bytes = new Uint8Array(buf, 5, len);
    return JSON.parse(new TextDecoder().decode(bytes)) as StateUpdatePayload;
}
