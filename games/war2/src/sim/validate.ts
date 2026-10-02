/**
 * Referee-side command validation (anti-cheat), netsim's shape: a command arrives from the network as untrusted data,
 * so `validateCommand` takes `unknown` and checks everything the sim would otherwise trust before it reaches sim
 * state — shape, integer and finite values, map bounds, type class, ownership, and sanity caps. It never throws: it
 * returns the command, normalized (only the known fields, `team` stamped as the issuer's), or why it's refused.
 *
 * Clients may send MOVE, STOP, BUILD, PRODUCE, CANCEL_PRODUCE and SET_RALLY. SPAWN is the host's (scenarios and setup
 * call the sim directly), and SPEED is a referee control, not a sim command: both are refused here.
 *
 * Apply-time still re-checks what depends on the tick the command lands in (placement, a building being finished, a
 * queue index still existing): systems/commands.ts is the deterministic source of truth for those.
 */
import type { Command } from "./command.ts";
import type { SimWorld } from "./world.ts";
import { CmdType } from "./command.ts";
import { FP, TILE_PX, WORLD_H, WORLD_W } from "./components.ts";
import { buildingTrains } from "./production.ts";
import { isBuildingType, unitFootprint, unitTypeDef } from "./unitTypes.ts";
import { eidForUnitId, unitEids } from "./world.ts";

/** Generous concurrent unit cap per team — a sanity bound, not an economy rule. */
export const MAX_LIVE_UNITS = 400;

/** Generous caps on what one entity can have queued (shift-queued orders, a building's production): sanity bounds
 *  too, so a client can't grow sim state without limit. */
export const MAX_QUEUED_ORDERS = 32;
export const MAX_QUEUED_PRODUCTION = 16;

export type Rejection =
	/** Not the shape of any command: a missing, non-integer or non-finite field, or a unit listed twice. */
	| "malformed"
	/** A command clients may not send (SPAWN, SPEED). */
	| "not-allowed"
	/** A referenced unit or building doesn't exist. */
	| "unknown-unit"
	/** It belongs to another team, or the command claims another team. */
	| "not-owner"
	/** The wrong class of thing: a building told to move, a unit asked to train, BUILD of a non-building, PRODUCE of
	 *  something that building doesn't train. */
	| "wrong-type"
	/** A point or footprint outside the map. */
	| "out-of-bounds"
	/** Over a sanity cap (MAX_LIVE_UNITS, MAX_QUEUED_*). */
	| "full";

export type Validation = { "ok": true; "command": Command } | { "ok": false; "reason": Rejection };

function refuse(reason: Rejection): Validation {
	return { "ok": false, "reason": reason };
}

function isInt(value: unknown): value is number {
	return Number.isSafeInteger(value);
}

/** The world's extent in FP: the map's, or the mapless default. */
function extentFP(world: SimWorld): [number, number] {
	const { w: mapW, h: mapH } = world.terrain;

	return mapW > 0 && mapH > 0 ? [mapW * TILE_PX * FP, mapH * TILE_PX * FP] : [WORLD_W, WORLD_H];
}

function inBoundsFP(world: SimWorld, x: number, y: number): boolean {
	const [w, h] = extentFP(world);

	return x >= 0 && y >= 0 && x < w && y < h;
}

function teamUnitCount(world: SimWorld, team: number): number {
	const { Unit } = world.components;

	return unitEids(world).filter((eid) => Unit.team[eid] === team).length;
}

/** The issuer's mobile units, by stable id: every one existing, owned, not a building, and listed once. */
function checkUnits(world: SimWorld, value: unknown, team: number): Rejection | undefined {
	const { Building, Unit } = world.components;

	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIVE_UNITS || !value.every(isInt) || new Set(value).size !== value.length) {
		return "malformed";
	}

	for (const uid of value as number[]) {
		const eid = eidForUnitId(world, uid);

		if (eid === undefined) {
			return "unknown-unit";
		}

		if (Unit.team[eid] !== team) {
			return "not-owner";
		}

		if (Building.fw[eid] > 0) {
			return "wrong-type";
		}
	}

	return undefined;
}

/** The issuer's building, by stable id: its entity, or why not. */
function checkBuilding(world: SimWorld, value: unknown, team: number): number | Rejection {
	const { Building, Unit } = world.components;

	if (!isInt(value)) {
		return "malformed";
	}

	const eid = eidForUnitId(world, value);

	if (eid === undefined) {
		return "unknown-unit";
	}

	if (Unit.team[eid] !== team) {
		return "not-owner";
	}

	return Building.fw[eid] > 0 ? eid : "wrong-type";
}

function validateUnitCommand(world: SimWorld, team: number, value: Record<string, unknown>, queue: boolean): Validation {
	const rejection = checkUnits(world, value["unitIds"], team);

	if (rejection !== undefined) {
		return refuse(rejection);
	}

	const unitIds = [...value["unitIds"] as number[]];

	if (queue && unitIds.some((uid) => (world.orders?.[uid]?.length ?? 0) >= MAX_QUEUED_ORDERS)) {
		return refuse("full");
	}

	if (value["type"] === CmdType.STOP) {
		return { "ok": true, "command": { "type": CmdType.STOP, "unitIds": unitIds, "queue": queue } };
	}

	const { txFP, tyFP } = value;

	if (!isInt(txFP) || !isInt(tyFP)) {
		return refuse("malformed");
	}

	if (!inBoundsFP(world, txFP, tyFP)) {
		return refuse("out-of-bounds");
	}

	return { "ok": true, "command": { "type": CmdType.MOVE, "unitIds": unitIds, "txFP": txFP, "tyFP": tyFP, "queue": queue } };
}

function validateBuild(world: SimWorld, team: number, value: Record<string, unknown>): Validation {
	const { tileX, tileY, typeId } = value;

	if (!isInt(typeId) || !isInt(tileX) || !isInt(tileY)) {
		return refuse("malformed");
	}

	if (!isBuildingType(typeId)) {
		return refuse("wrong-type");
	}

	const [fw, fh] = unitFootprint(typeId);
	const [w, h] = extentFP(world);

	if (tileX < 0 || tileY < 0 || (tileX + fw) * TILE_PX * FP > w || (tileY + fh) * TILE_PX * FP > h) {
		return refuse("out-of-bounds");
	}

	if (teamUnitCount(world, team) >= MAX_LIVE_UNITS) {
		return refuse("full");
	}

	return { "ok": true, "command": { "type": CmdType.BUILD, "typeId": typeId, "team": team, "tileX": tileX, "tileY": tileY } };
}

function validateBuildingCommand(world: SimWorld, team: number, value: Record<string, unknown>): Validation {
	const { Unit } = world.components;
	const eid = checkBuilding(world, value["buildingUid"], team);

	if (typeof eid === "string") {
		return refuse(eid);
	}

	const buildingUid = value["buildingUid"] as number;

	if (value["type"] === CmdType.PRODUCE) {
		const { productTypeId } = value;

		if (!isInt(productTypeId)) {
			return refuse("malformed");
		}

		if (unitTypeDef(productTypeId) === undefined || isBuildingType(productTypeId) || !buildingTrains(Unit.type[eid], productTypeId)) {
			return refuse("wrong-type");
		}

		if (teamUnitCount(world, team) >= MAX_LIVE_UNITS || (world.production?.[buildingUid]?.queue.length ?? 0) >= MAX_QUEUED_PRODUCTION) {
			return refuse("full");
		}

		return { "ok": true, "command": { "type": CmdType.PRODUCE, "buildingUid": buildingUid, "productTypeId": productTypeId, "team": team } };
	}

	if (value["type"] === CmdType.CANCEL_PRODUCE) {
		const { index } = value;

		if (!isInt(index) || index < 0) {
			return refuse("malformed");
		}

		return { "ok": true, "command": { "type": CmdType.CANCEL_PRODUCE, "buildingUid": buildingUid, "index": index, "team": team } };
	}

	const { txFP, tyFP } = value;

	if (!isInt(txFP) || !isInt(tyFP)) {
		return refuse("malformed");
	}

	if (!inBoundsFP(world, txFP, tyFP)) {
		return refuse("out-of-bounds");
	}

	return { "ok": true, "command": { "type": CmdType.SET_RALLY, "buildingUid": buildingUid, "txFP": txFP, "tyFP": tyFP, "team": team } };
}

/** Check a command from `team` against `world`. Never throws; returns the command, normalized, or why it's refused. */
export function validateCommand(world: SimWorld, team: number, input: unknown): Validation {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return refuse("malformed");
	}

	const value = input as Record<string, unknown>;

	// `team`, if present, has to be the issuer's (the result carries the issuer's either way).
	if (value["team"] !== undefined && value["team"] !== team) {
		return refuse("not-owner");
	}

	if (value["queue"] !== undefined && typeof value["queue"] !== "boolean") {
		return refuse("malformed");
	}

	switch (value["type"]) {
		case CmdType.MOVE:
		case CmdType.STOP:
			return validateUnitCommand(world, team, value, value["queue"] === true);
		case CmdType.BUILD:
			return validateBuild(world, team, value);
		case CmdType.PRODUCE:
		case CmdType.CANCEL_PRODUCE:
		case CmdType.SET_RALLY:
			return validateBuildingCommand(world, team, value);
		case CmdType.SPAWN:
		case CmdType.SPEED:
			return refuse("not-allowed");
		default:
			return refuse("malformed");
	}
}
