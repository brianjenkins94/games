/**
 * Command logs: which team issued what, on which tick. Advancing a world through a log applies each tick's commands
 * (in log order) and then steps — the one definition of "play" shared by the referee, replays and tests.
 */
import type { World } from "./world.ts";
import { applyCommand } from "./commands.ts";
import { stepWorld } from "./step.ts";

export interface LogEntry {
	"tick": number;
	"team": number;
	"command": unknown;
}

/** Apply the log's commands for the world's current tick, then step once. */
export function advance(world: World, log: readonly LogEntry[]): void {
	for (const entry of log) {
		if (entry.tick === world.tick) {
			applyCommand(world, entry.team, entry.command);
		}
	}

	stepWorld(world);
}

/** Advance until the world reaches `tick`, calling `onTick` after each step (for recording hashes). */
export function advanceTo(world: World, log: readonly LogEntry[], tick: number, onTick?: (world: World) => void): void {
	while (world.tick < tick) {
		advance(world, log);
		onTick?.(world);
	}
}
