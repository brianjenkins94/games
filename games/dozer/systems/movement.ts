import { query } from "bitecs";
import { Position }   from "../schemas/position";
import { MoveIntent } from "../schemas/moveIntent";
import { Pushable }   from "../schemas/pushable";
import { Direction }  from "../schemas/direction";

const deltas: Record<number, [number, number]> = {
    [Direction.Up]:    [0, -1],
    [Direction.Right]: [1,  0],
    [Direction.Down]:  [0,  1],
    [Direction.Left]:  [-1, 0],
};

function entityAt(world, x: number, y: number, exclude = -1): number | undefined {
    for (const eid of query(world, [Pushable, Position])) {
        if (eid !== exclude && Position.x[eid] === x && Position.y[eid] === y) {
            return eid;
        }
    }
    return undefined;
}

export function movementSystem(world) {
    const { walls } = world;

    for (const eid of query(world, [MoveIntent, Position])) {
        const dir = MoveIntent.direction[eid];
        if (!dir) continue; // Direction.None === 0

        const [dx, dy] = deltas[dir];
        const x  = Position.x[eid];
        const y  = Position.y[eid];
        const nx = x + dx;
        const ny = y + dy;

        if (walls.has(`${nx},${ny}`)) {
            MoveIntent.direction[eid] = Direction.None;
            continue;
        }

        const pushedEid = entityAt(world, nx, ny);

        if (pushedEid !== undefined) {
            const bx = nx + dx;
            const by = ny + dy;

            if (walls.has(`${bx},${by}`) || entityAt(world, bx, by, pushedEid) !== undefined) {
                MoveIntent.direction[eid] = Direction.None;
                continue;
            }

            Position.x[pushedEid] = bx;
            Position.y[pushedEid] = by;
        }

        Position.x[eid] = nx;
        Position.y[eid] = ny;
        MoveIntent.direction[eid] = Direction.None;
    }
}
