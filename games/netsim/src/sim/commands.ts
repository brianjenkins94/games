/**
 * Player commands. They arrive from the network as untrusted data, so `validateCommand` takes `unknown` and checks
 * shape, integer/finite values, bounds and ownership before anything reaches sim state.
 */
import type { World } from "./world.ts";
import { inBounds } from "./world.ts";

export type Command =
	| { "type": "move"; "units": number[]; "x": number; "y": number }
	| { "type": "stop"; "units": number[] };

export type Rejection = "malformed" | "unknown-unit" | "not-owner" | "out-of-bounds";

export type Validation = { "ok": true; "command": Command } | { "ok": false; "reason": Rejection };

function isUnitList(value: unknown): value is number[] {
	return Array.isArray(value) && value.length > 0 && value.every((id) => Number.isSafeInteger(id));
}

/** Check a command from `team` against `world`. Never throws; returns the command, normalized, or why it's refused. */
export function validateCommand(world: World, team: number, input: unknown): Validation {
	if (typeof input !== "object" || input === null) {
		return { "ok": false, "reason": "malformed" };
	}

	const value = input as Record<string, unknown>;

	if (!isUnitList(value["units"])) {
		return { "ok": false, "reason": "malformed" };
	}

	const units = [...value["units"]];

	for (const id of units) {
		const unit = world.units.get(id);

		if (unit === undefined) {
			return { "ok": false, "reason": "unknown-unit" };
		}

		if (unit.team !== team) {
			return { "ok": false, "reason": "not-owner" };
		}
	}

	if (value["type"] === "stop") {
		return { "ok": true, "command": { "type": "stop", "units": units } };
	}

	if (value["type"] === "move") {
		const { x, y } = value;

		if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
			return { "ok": false, "reason": "malformed" };
		}

		if (!inBounds(world, x as number, y as number)) {
			return { "ok": false, "reason": "out-of-bounds" };
		}

		return { "ok": true, "command": { "type": "move", "units": units, "x": x as number, "y": y as number } };
	}

	return { "ok": false, "reason": "malformed" };
}

/** Validate, then apply. */
export function applyCommand(world: World, team: number, input: unknown): Validation {
	const result = validateCommand(world, team, input);

	if (!result.ok) {
		return result;
	}

	const { command } = result;

	for (const id of command.units) {
		const unit = world.units.get(id);

		if (command.type === "move") {
			unit.tx = command.x;
			unit.ty = command.y;
			unit.moving = unit.x === command.x && unit.y === command.y ? 0 : 1;
		} else {
			unit.tx = unit.x;
			unit.ty = unit.y;
			unit.moving = 0;
		}
	}

	return result;
}
