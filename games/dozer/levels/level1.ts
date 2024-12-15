import { Tilemap } from "../../../util/phaser/tilemap";

export const level1 = new Tilemap(20, 12);

level1.addTileset("wall_block", new URL("../assets/sprites/wall_block.png", import.meta.url).toString());
level1.addTileset("boulder", new URL("../assets/sprites/boulder.png", import.meta.url).toString());
level1.addTileset("gray_square", new URL("../assets/sprites/gray_square.png", import.meta.url).toString());
level1.addTileset("target", new URL("../assets/sprites/target.png", import.meta.url).toString());
level1.addTileset("player", new URL("../assets/sprites/dozer.png", import.meta.url).toString());

level1.addLayer("background")
    .addProperty({
        "name": "ge_charLayer",
        "type": "string",
        "value": "background"
    })
    .fill(1);

level1.addLayer("layer1")
    .addProperty({
        "name": "ge_charLayer",
        "type": "string",
        "value": "layer1"
    })
    .bitblt(7, 3, [
        [, , 3, , ,],
        [, , 3, , ,],
        [, , 3, 3, 3, 3],
        [3, 3, 3, 3, ,],
        [, , , 3, ,],
        [, , , 3, ,]
    ]);

level1.addObjectLayer("objects")
    .bitblt(7, 3, [
        [, , 4, , ,],
        [, , , , ,],
        [, , 2, , 2, 4],
        [4, , 2, 5, ,],
        [, , , 2, ,],
        [, , , 4, ,]
    ]);
