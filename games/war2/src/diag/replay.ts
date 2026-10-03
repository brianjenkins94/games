/**
 * Replaying a fixture (recorder.ts): the match rebuilt on its map, restored to its snapshot, its commands applied at
 * their ticks — deterministic, so it reaches the captured moment exactly — then on, `settleBudget` ticks past it, with
 * the pathology detector watching. What it finds: whether it reached the captured world (its hash at the flag tick),
 * and the focus unit's fate — every fault the detector found with it, and whether it came to rest within a tile of its
 * goal. (W4, see MIGRATION.md.)
 */
import type { Command } from "../sim/command.ts";
import type { MapInfo } from "../sim/world.ts";
import type { Fixture } from "./recorder.ts";
import type { Pathology } from "./pathology.ts";
import { applySnapshot, worldHash } from "../sim/snapshot.ts";
import { applyCommands } from "../sim/commandSystem.ts";
import { createSimWorld, stepWorld } from "../sim/world.ts";
import { createPathologyDetector } from "./pathology.ts";

export interface Replay {
	/** The world's hash at the flag tick, and whether it's the captured one. */
	"hash": number;
	"faithful": boolean;
	/** Every fault the detector found with the focus unit, from the snapshot to the end. */
	"focusFaults": Set<Pathology>;
	/** Whether the focus unit came to rest within a tile of its goal (after the flag). */
	"focusReached": boolean;
}

export function replayFixture(fixture: Fixture, map: MapInfo): Replay {
	const world = createSimWorld(fixture.seed, map, fixture.teams);
	const detector = createPathologyDetector();
	const byTick = new Map<number, Command[]>();
	const end = fixture.flagTick + (fixture.expect.settleBudget ?? 300);
	const replay: Replay = { "hash": 0, "faithful": false, "focusFaults": new Set(), "focusReached": false };

	applySnapshot(world, fixture.snapshot);

	for (const { tick, command } of fixture.commands) {
		byTick.set(tick, [...byTick.get(tick) ?? [], command]);
	}

	while (world.tick < end) {
		// A command logged at tick T was applied in the step that made T.
		const commands = byTick.get(world.tick + 1) ?? [];

		applyCommands(world, commands);
		stepWorld(world);

		for (const [uid, pathology] of detector.scan(world, commands)) {
			if (uid === fixture.focus?.uid) {
				replay.focusFaults.add(pathology);
			}
		}

		if (world.tick === fixture.flagTick) {
			replay.hash = worldHash(world);
			replay.faithful = replay.hash === fixture.expectHash;
		}

		const eid = fixture.focus === undefined ? undefined : world.eidOf.get(fixture.focus.uid);

		if (eid !== undefined && world.tick > fixture.flagTick && world.components.MoveTarget.active[eid] === 0) {
			const { Path } = world.components;
			const [gx, gy] = fixture.focus!.goal;

			replay.focusReached ||= Math.max(Math.abs(Path.curTx[eid] - gx), Math.abs(Path.curTy[eid] - gy)) <= 1;
		}
	}

	return replay;
}
