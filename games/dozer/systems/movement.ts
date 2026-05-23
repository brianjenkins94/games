import { defineSystem, defineQuery } from "../../../util/phaser/bitecs";
import { Direction } from "../schemas/direction";

// Tile-space deltas for each direction.
const deltas: Record<number, [number, number]> = {
    [Direction.Up]:    [0, -1],
    [Direction.Right]: [1,  0],
    [Direction.Down]:  [0,  1],
    [Direction.Left]:  [-1, 0],
};

export function createMovementSystem(scene, [MoveIntent, Position, Pushable]) {
    const moverQuery   = defineQuery([MoveIntent, Position]);
    const pushableQuery = defineQuery([Pushable, Position]);

    function entityAt(x: number, y: number, exclude = -1): number | undefined {
        for (const peid of pushableQuery(scene.world)) {
            if (peid !== exclude && Position.get(peid, "x") === x && Position.get(peid, "y") === y) {
                return peid;
            }
        }
        return undefined;
    }

    return defineSystem(function(world) {
        for (const eid of moverQuery(world)) {
            const dir = MoveIntent.get(eid, "direction");

            if (!dir) continue; // Direction.None === 0

            const [dx, dy] = deltas[dir];
            const x  = Position.get(eid, "x");
            const y  = Position.get(eid, "y");
            const nx = x + dx;
            const ny = y + dy;

            // Wall check.
            if (scene.walls.has(`${nx},${ny}`)) {
                MoveIntent.set(eid, "direction", Direction.None);
                continue;
            }

            // Check for a pushable at the target tile.
            const pushedEid = entityAt(nx, ny);

            if (pushedEid !== undefined) {
                const bx = nx + dx;
                const by = ny + dy;

                // Boulder can't move into a wall or another boulder.
                if (scene.walls.has(`${bx},${by}`) || entityAt(bx, by, pushedEid) !== undefined) {
                    MoveIntent.set(eid, "direction", Direction.None);
                    continue;
                }

                Position.set(pushedEid, "x", bx);
                Position.set(pushedEid, "y", by);
            }

            Position.set(eid, "x", nx);
            Position.set(eid, "y", ny);
            MoveIntent.set(eid, "direction", Direction.None);
        }

        return world;
    });
}
