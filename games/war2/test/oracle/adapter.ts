/**
 * The oracle's adapter: run a scenario on a sim, and read its canonical state each tick. Commands go through the
 * sim's own command pipeline (`applyCommands`), as its referee applies them, before each step.
 *
 * One adapter for both sims — the old one (legacy.ts) and the new (sim.ts) — given a small driver for each (`Sim`):
 * the game API is the same, but the old sim keeps its components and vision in module globals, and the new one on
 * each game's world.
 */
import type { CanonicalState, CanonicalUnit } from "./canonical.ts";
import type { Scenario, ScriptCommand } from "./scenarios.ts";
import type { Components } from "../../src/sim/components.ts";
import type * as GameModule from "../game.ts";
import { hasComponent } from "bitecs";
import { fnv } from "./canonical.ts";
import { mapInfo } from "./scenarios.ts";

/** What the adapter needs of a sim: a game, and — for a given game — its components, explored maps and reveal. */
export interface Sim {
	"createGame": typeof GameModule.createGame;
	"components": (game: Game) => Pick<Components, "Building" | "MoveTarget" | "Position" | "Unit" | "UnitId">;
	"exportExplored": (game: Game) => [number, number[]][];
	"revealAll": (game: Game) => void;
	"tileCenterFP": (tile: number) => number;
	"unitTypeId": (name: string) => number;
	"unitTypeName": (id: number) => string;
}

// The command types (the old protocol's const enum, inlined; the same numbers in the new sim's CmdType).
const CMD = { "MOVE": 1, "STOP": 3, "BUILD": 4, "PRODUCE": 6, "SET_RALLY": 7, "CANCEL_PRODUCE": 8 } as const;

type Game = GameModule.GameInstance;

/** How often a run restores itself: at the start of every `every`th tick it snapshots the sim, starts a fresh one
 *  from nothing but that snapshot, and goes on in that one. */
export interface Restore { "every": number }

/** Each tick's canonical state; and, for a caller that wants to look inside, the game and the commands applied
 *  before that tick's step (empty after setup). */
export type Runner = (scenario: Scenario, onTick: (state: CanonicalState, game: Game, applied: unknown[]) => void, restore?: Restore) => void;

/** A scenario runner for `sim`: it hands each tick's state (after setup, then after every step) to `onTick`. */
export function adapter(sim: Sim): Runner {
	const { createGame, exportExplored, revealAll, tileCenterFP, unitTypeId, unitTypeName } = sim;

	function canonical(game: Game): CanonicalState {
		const { Building, MoveTarget, Position, Unit, UnitId } = sim.components(game);
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

		return { "tick": game.world.tick, "units": units, "explored": Object.fromEntries(exportExplored(game).map(([team, explored]) => [team, fnv(explored.join(""))])) };
	}

	return (scenario, onTick, restore) => {
		let game = createGame(scenario.seed, mapInfo(scenario.map));

		if (!scenario.fog) {
			revealAll(game);
		}

		game.initUnitIdCounter(0);

		const { Building, UnitId } = sim.components(game);

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

		onTick(canonical(game), game, []);

		for (let tick = 0; tick < scenario.ticks; tick += 1) {
			if (restore !== undefined && tick > 0 && tick % restore.every === 0) {
				const snapshot = game.takeSnapshot();

				game = createGame(scenario.seed, mapInfo(scenario.map));
				game.applySnapshot(snapshot);
			}

			const applied = (byTick.get(tick) ?? []).map(toCommand);

			if (applied.length > 0) {
				game.applyCommands(applied as Parameters<Game["applyCommands"]>[0]);
			}

			game.step();
			onTick(canonical(game), game, applied);
		}
	};
}
