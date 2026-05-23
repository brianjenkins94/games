import { defineSystem, defineQuery } from "../../../util/phaser/bitecs";

export function createWinSystem(scene, [Position, Pushable, Target]) {
    const pushableQuery = defineQuery([Pushable, Position]);
    const targetQuery   = defineQuery([Target,   Position]);

    return defineSystem(function(world) {
        // Collect all target positions each tick (cheap for puzzle-scale worlds).
        const targetPositions = new Set<string>();
        for (const eid of targetQuery(world)) {
            targetPositions.add(`${Position.get(eid, "x")},${Position.get(eid, "y")}`);
        }

        if (targetPositions.size === 0) return world;

        // Win if every boulder sits on a target.
        for (const eid of pushableQuery(world)) {
            if (!targetPositions.has(`${Position.get(eid, "x")},${Position.get(eid, "y")}`)) {
                return world;
            }
        }

        console.log("You win!");
        // TODO: scene transition / restart
        return world;
    });
}
