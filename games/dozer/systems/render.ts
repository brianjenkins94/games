import { defineSystem, defineQuery } from "../../../util/phaser/bitecs";

export function createRenderSystem(scene, [Position]) {
    const query = defineQuery([Position]);
    const { tileWidth, tileHeight } = scene.tileConfig;

    return defineSystem(function(world) {
        for (const eid of query(world)) {
            const sprite = scene.sprites.get(eid);
            if (!sprite) continue;

            // Position components hold tile coordinates; convert to pixel center.
            sprite.x = Position.get(eid, "x") * tileWidth + tileWidth  / 2;
            sprite.y = Position.get(eid, "y") * tileHeight + tileHeight / 2;
        }

        return world;
    });
}
