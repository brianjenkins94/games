import { query } from "bitecs";
import { Position } from "../schemas/position";
import { Pushable } from "../schemas/pushable";
import { Target }   from "../schemas/target";

export function winSystem(world) {
    const targets = new Set<string>();
    for (const eid of query(world, [Target, Position])) {
        targets.add(`${Position.x[eid]},${Position.y[eid]}`);
    }

    if (!targets.size) return;

    for (const eid of query(world, [Pushable, Position])) {
        if (!targets.has(`${Position.x[eid]},${Position.y[eid]}`)) return;
    }

    world.onWin?.();
}
