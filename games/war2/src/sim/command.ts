/**
 * Commands: a player's intents, as the sim applies them (commandSystem.ts). Moved here from the old wire protocol
 * (net/protocol.ts), whose packets and framing W2 replaces with netsim's — these are the sim's, not the wire's.
 *
 * Commands are intents. The referee assigns unit ids for SPAWN/BUILD (clients don't mint them); `team` is the issuing
 * client's team, validated and stamped by the referee. `queue` (MOVE/STOP): true appends to the unit's action queue
 * (shift-click); absent or false replaces the current order and clears the queue (see orders.ts).
 */
import type { UnitSnapshot } from "./types.ts";

export type { UnitSnapshot };

/** (A plain object, not an enum: Node runs this file as it is, and erasable TypeScript has no enums.) */
export const CmdType = { "MOVE": 1, "SPAWN": 2, "STOP": 3, "BUILD": 4, "SPEED": 5, "PRODUCE": 6, "SET_RALLY": 7, "CANCEL_PRODUCE": 8 } as const;

export interface MoveCmd { "type": typeof CmdType.MOVE; "unitIds": number[]; "txFP": number; "tyFP": number; "queue"?: boolean }
export interface SpawnCmd { "type": typeof CmdType.SPAWN; "xFP": number; "yFP": number; "team": number; "typeId": number }
export interface StopCmd { "type": typeof CmdType.STOP; "unitIds": number[]; "queue"?: boolean }
export interface BuildCmd { "type": typeof CmdType.BUILD; "typeId": number; "team": number; "tileX": number; "tileY": number }
/** Control plane (not a world mutation): the authoritative game-speed multiplier. The referee applies it; it never
 *  reaches applyCommands. */
export interface SpeedCmd { "type": typeof CmdType.SPEED; "speed": number }
/** Building production (see production.ts): PRODUCE enqueues a trainable unit type at a building; CANCEL_PRODUCE
 *  drops the queue item at `index`; SET_RALLY points freshly trained units at a destination. `buildingUid` is the
 *  building's stable UnitId. */
export interface ProduceCmd { "type": typeof CmdType.PRODUCE; "buildingUid": number; "productTypeId": number; "team": number }
export interface CancelProduceCmd { "type": typeof CmdType.CANCEL_PRODUCE; "buildingUid": number; "index": number; "team": number }
export interface SetRallyCmd { "type": typeof CmdType.SET_RALLY; "buildingUid": number; "txFP": number; "tyFP": number; "team": number }
export type Command = MoveCmd | SpawnCmd | StopCmd | BuildCmd | SpeedCmd | ProduceCmd | CancelProduceCmd | SetRallyCmd;
