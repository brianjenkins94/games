/** Test helpers: a small default world, and seeded random scenarios (spawns + a command log) for property tests. */
import type { LogEntry, World, WorldConfig } from "../src/sim/index.ts";
import { createRng, createWorld, nextInt, spawnUnit, tiles } from "../src/sim/index.ts";

export const DEFAULTS: WorldConfig = { "width": 32, "height": 32, "teams": 2, "seed": 1, "speed": 125, "sight": tiles(5) };

export function makeWorld(overrides: Partial<WorldConfig> = {}): World {
	return createWorld({ ...DEFAULTS, ...overrides });
}

export interface Scenario {
	"world": World;
	"log": LogEntry[];
}

/**
 * A world with `perTeam` units per team at random positions (drawn from the world's own RNG) and a log of random
 * moves and stops over `ticks` ticks, drawn from a separate generator so the log doesn't consume sim randomness.
 */
export function randomScenario(seed: number, { perTeam = 4, ticks = 200, commands = 40 } = {}): Scenario {
	const world = makeWorld({ "seed": seed });
	const size = tiles(world.config.width);

	for (let team = 0; team < world.config.teams; team += 1) {
		for (let index = 0; index < perTeam; index += 1) {
			spawnUnit(world, team, nextInt(world.rng, 0, size), nextInt(world.rng, 0, size));
		}
	}

	const script = createRng(seed ^ 0x5EED);
	const ids = [...world.units.values()];
	const log: LogEntry[] = [];

	for (let index = 0; index < commands; index += 1) {
		const unit = ids[nextInt(script, 0, ids.length)];
		const tick = nextInt(script, 0, ticks);

		log.push(nextInt(script, 0, 5) === 0
			? { "tick": tick, "team": unit.team, "command": { "type": "stop", "units": [unit.id] } }
			: { "tick": tick, "team": unit.team, "command": { "type": "move", "units": [unit.id], "x": nextInt(script, 0, size), "y": nextInt(script, 0, size) } });
	}

	log.sort((left, right) => left.tick - right.tick);

	return { "world": world, "log": log };
}
