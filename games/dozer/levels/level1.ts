import { Scene } from 'phaser';
import { Tilemap } from "../../../util/phaser/tilemap";
import { CollisionStrategy } from "../../../util/phaser/grid-engine/src/GridEngine";

const name = "level1";

export function loadLevel1(scene: Scene, objectMap = {}) {
    const tilemap = new Tilemap(20, 12);

    tilemap.addTileset("wall_block", new URL("../assets/sprites/wall_block.png", import.meta.url).toString());
    tilemap.addTileset("boulder", new URL("../assets/sprites/boulder.png", import.meta.url).toString());
    tilemap.addTileset("gray_square", new URL("../assets/sprites/gray_square.png", import.meta.url).toString());
    tilemap.addTileset("target", new URL("../assets/sprites/target.png", import.meta.url).toString());
    tilemap.addTileset("player", new URL("../assets/sprites/dozer.png", import.meta.url).toString());

    tilemap.addLayer("background").fill(1);
    tilemap.addLayer("layer1")
        .addProperty({
            "name": "ge_charLayer",
            "type": "string",
            "value": "layer1"
        })
        .bitblt(7, 3, [
        [ ,  , 3,  ,  ,  ],
        [ ,  , 3,  ,  ,  ],
        [ ,  , 3, 3, 3, 3],
        [3, 3, 3, 3,  ,  ],
        [ ,  ,  , 3,  ,  ],
        [ ,  ,  , 3,  ,  ]
    ]);
    tilemap.addObjectLayer("objects").bitblt(7, 3, [
        [ ,  , 4,  ,  ,  ],
        [ ,  ,  ,  ,  ,  ],
        [ ,  , 2,  , 2, 4],
        [4,  , 2, 5,  ,  ],
        [ ,  ,  , 2,  ,  ],
        [ ,  ,  , 4,  ,  ]
    ]);

    scene.cache.tilemap.add(name, { "format": Phaser.Tilemaps.Formats.TILED_JSON, "data": tilemap })
    const tilemapInstance = scene.cache.tilemap.add(name, Phaser.Tilemaps.ParseToTilemap(scene, name, tilemap.tilewidth, tilemap.tileheight, tilemap.width, tilemap.height)).get(name)

    for (const { name, image } of tilemap.tilesets) {
        scene.load.image(name, image);

        scene.load.once("filecomplete-image-" + name, function(key, type, data) {
            tilemapInstance.addTilesetImage(name);
        });
    }

    scene.load.once("complete", function(loader, totalComplete, totalFailed) {
        tilemapInstance.createLayer("background", tilemapInstance.tilesets)

        for (const { objects } of tilemapInstance.objects) {
            tilemapInstance.createLayer("layer1", tilemapInstance.tilesets);

            scene.events.once("preupdate", function() {
                const characters = [];

                const objectCount = {};

                for (const { name, x, y, width, height } of objects) {
                    objectCount[name] ??= 1;

                    characters.push({
                        ...Object.fromEntries(tilemap.tilesets.map(({ name }) => [name, objectMap[name]]))[name],
                        "id": (objectCount[name] -= 1) ? name + objectCount[name] : name,
                        "sprite": scene.add.sprite(0, 0, name),
                        "startPosition": {
                            // FIXME: `width` and `height` are of the tiles, not the tilemap.
                            "x": x / width,
                            "y": y / height
                        },
                    });
                }

                scene.gridEngine.create(scene.cache.tilemap.get(name), {
                    "characters": characters,
                    "characterCollisionStrategy": CollisionStrategy.BLOCK_ONE_TILE_AHEAD,
                });
            });
        }
    });

    return tilemapInstance;
}
