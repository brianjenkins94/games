/**
 * The oracle's adapter for the old sim (../../legacy): run a scenario on it, and read its canonical state each tick.
 * Commands go through the old sim's own command pipeline (`applyCommands`), as its referee applied them, before each
 * step.
 */
import type { CanonicalState, CanonicalUnit } from "./canonical.ts";
import type { Scenario, ScriptCommand } from "./scenarios.ts";
import { hasComponent } from "bitecs";
import { Building, MoveTarget, Position, tileCenterFP, Unit, UnitId } from "../../legacy/src/game/components.ts";
import { createGame } from "../../legacy/src/game/game.ts";
import { unitTypeId, unitTypeName } from "../../legacy/src/game/unitTypes.ts";
import { exportExplored, revealAll } from "../../legacy/src/game/vision.ts";
import { fnv } from "./canonical.ts";
import { mapInfo } from "./scenarios.ts";

// The old protocol's command types (a const enum there: inlined).
const CMD = { "MOVE": 1, "STOP": 3, "BUILD": 4, "PRODUCE": 6, "SET_RALLY": 7, "CANCEL_PRODUCE": 8 } as const;

type Game = ReturnType<typeof createGame>;

function canonical(game: Game): CanonicalState {
	const units = game.unitEids().map((eid): CanonicalUnit => {
		const uid = UnitId.id[eid]!;
		const unit: CanonicalUnit = { "uid": uid, "type": unitTypeName(Unit.type[eid]!), "team": Unit.team[eid]!, "x": Position.x[eid]!, "y": Position.y[eid]! };

		if (MoveTarget.active[eid] === 1) {
			unit.target = [MoveTarget.tx[eid]!, MoveTarget.ty[eid]!];
		}

		if (hasComponent(game.world, eid, Building)) {
			unit.building = { "w": Building.fw[eid]!, "h": Building.fh[eid]!, "buildLeft": Building.buildLeft[eid]! };
		}

		const orders = game.world.orders?.[uid];
		const production = game.world.production?.[uid];
		const rally = game.world.rally?.[uid];

		if (orders !== undefined && orders.length > 0) {
			unit.orders = orders.map((order) => ({ ...order }));
		}

		if (production !== undefined) {
			unit.production = { "queue": production.queue.map((type) => unitTypeName(type)), "ticksLeft": production.ticksLeft, "ticksTotal": production.ticksTotal };
		}

		if (rally !== undefined) {
			unit.rally = [rally.txFP, rally.tyFP];
		}

		return unit;
	}).sort((left, right) => left.uid - right.uid);

	return { "tick": game.world.tick, "units": units, "explored": Object.fromEntries(exportExplored().map(([team, explored]) => [team, fnv(explored.join(""))])) };
}

/** Run `scenario` on the old sim, handing each tick's state (the state after setup, then after every step) to
 *  `onTick`. */
export function runLegacy(scenario: Scenario, onTick: (state: CanonicalState) => void): void {
	const game = createGame(scenario.seed, mapInfo(scenario.map));

	if (!scenario.fog) {
		revealAll();
	}

	game.initUnitIdCounter(0);

	const unitUids = scenario.spawns.map((spawn) => UnitId.id[game.spawnUnit(tileCenterFP(spawn.tile[0]), tileCenterFP(spawn.tile[1]), spawn.team ?? 0, undefined, unitTypeId(spawn.type))]!);
	const buildings = scenario.buildings.map((building) => {
		const eid = game.spawnBuilding(building.tile[0], building.tile[1], building.team ?? 0, unitTypeId(building.type));

		Building.buildLeft[eid] = 0; // placed finished, as the old suite's scenarios did

		return { "uid": UnitId.id[eid]!, "team": building.team ?? 0 };
	});
	const byTick = new Map<number, ScriptCommand[]>();

	for (const command of scenario.script) {
		byTick.set(command.at, [...byTick.get(command.at) ?? [], command]);
	}

	const toCommand = (command: ScriptCommand): unknown => {
		if ("move" in command) {
			return { "type": CMD.MOVE, "unitIds": command.move.map((index) => unitUids[index]), "txFP": tileCenterFP(command.to[0]), "tyFP": tileCenterFP(command.to[1]), ...command.queue === true ? { "queue": true } : {} };
		}

		if ("stop" in command) {
			return { "type": CMD.STOP, "unitIds": command.stop.map((index) => unitUids[index]), ...command.queue === true ? { "queue": true } : {} };
		}

		if ("produce" in command) {
			return { "type": CMD.PRODUCE, "buildingUid": buildings[command.produce]!.uid, "productTypeId": unitTypeId(command.type), "team": command.team ?? buildings[command.produce]!.team };
		}

		if ("rally" in command) {
			return { "type": CMD.SET_RALLY, "buildingUid": buildings[command.rally]!.uid, "txFP": tileCenterFP(command.to[0]), "tyFP": tileCenterFP(command.to[1]), "team": command.team ?? buildings[command.rally]!.team };
		}

		if ("cancel" in command) {
			return { "type": CMD.CANCEL_PRODUCE, "buildingUid": buildings[command.cancel]!.uid, "index": command.index, "team": command.team ?? buildings[command.cancel]!.team };
		}

		return { "type": CMD.BUILD, "typeId": unitTypeId(command.build), "team": command.team ?? 0, "tileX": command.tile[0], "tileY": command.tile[1] };
	};

	onTick(canonical(game));

	for (let tick = 0; tick < scenario.ticks; tick += 1) {
		const commands = byTick.get(tick);

		if (commands !== undefined) {
			game.applyCommands(commands.map(toCommand) as Parameters<Game["applyCommands"]>[0]);
		}

		game.step();
		onTick(canonical(game));
	}
}
