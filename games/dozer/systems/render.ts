import { query } from "bitecs";
import { Position } from "../schemas/position";

export function renderSystem(world) {
    const { sprites, tileConfig: { tileWidth, tileHeight } } = world;

    for (const eid of query(world, [Position])) {
        const sprite = sprites.get(eid);
        if (!sprite) continue;

        sprite.x = Position.x[eid] * tileWidth  + tileWidth  / 2;
        sprite.y = Position.y[eid] * tileHeight + tileHeight / 2;
    }
}
