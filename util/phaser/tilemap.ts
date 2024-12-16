import { Scene } from "phaser";
import { CollisionStrategy, GridEngine } from "./grid-engine/src/GridEngine";
import { addEntity } from "bitecs";

import type { IWorld } from "./bitecs/World";

// https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation
declare module "phaser" {
    interface Scene {
        gridEngine: GridEngine;
        entities: any;
        components: any;
        systems: any;
        world: IWorld;
    }
}

class Layer {
    data;
    height;
    id;
    name;
    opacity = 1;
    type = "tilelayer";
    visible = true;
    width;
    x = 0;
    y = 0;
    properties;

    constructor(name, tilemap) {
        this.data = new Array(tilemap.width * tilemap.height).fill(0);
        this.height = tilemap.height;
        this.id = tilemap.nextlayerid;
        this.name = name;
        this.width = tilemap.width;
    }

    addProperty(property) {
        this.properties ??= [];

        this.properties.push(property)

        return this;
    }

    fill(gid) {
        this.data = this.data.fill(gid)

        return this;
    }

    bitblt(dx, dy, source) {
        for (let x = 0; x <= source[0].length; x++) {
            for (let y = 0; y <= source.length; y++) {
                if (source[x]?.[y] !== undefined) {
                    this.data[((dy + x) * this.width) + dx + y] = source[x][y];
                }
            }
        }

        return this;
    }
}

export class Tilemap {
    compressionlevel = -1;
    height;
    infinite = false;
    layers = [];
    nextlayerid = 1;
    nextobjectid = 1;
    orientation = "orthogonal";
    renderorder = "right-down";
    tiledversion = "1.11.0";
    tileheight;
    tilesets = [];
    tilewidth;
    type = "map";
    version = "1.10";
    width;

    constructor(width, height, tileWidth = 32, tileHeight = 32) {
        this.width = width;
        this.height = height;
        this.tilewidth = tileWidth;
        this.tileheight = tileHeight;
    }

    addTileset(name, imagePath, tileProperties = []) {
        this.tilesets.push({
            "columns": 1,
            // FIXME: This assumes one tile per tileset.
            "firstgid": this.tilesets.length + 1,
            "image": imagePath,
            "imageheight": this.tileheight,
            "imagewidth": this.tilewidth,
            "margin": 0,
            "name": name,
            "spacing": 0,
            "tilecount": 1,
            "tileheight": this.tileheight,
            "tilewidth": this.tilewidth,
            "tiles": tileProperties
        })

        this.nextobjectid += 1;
    }

    addLayer(name) {
        this.layers.push(new Layer(name, this))

        this.nextlayerid += 1;

        return this.layers.at(-1);
    }

    addObjectLayer(name) {
        const parent = this;

        class ObjectLayer {
            draworder = "topdown";
            id = 8;
            name;
            objects = [];
            opacity = 1;
            type = "objectgroup";
            visible = true;
            x = 0;
            y = 0;
            properties;

            constructor(name) {
                this.name = name;
            }

            addProperty(property) {
                this.properties ??= [];

                this.properties.push(property)

                return this;
            }

            addObject(gid, x, y) {
                this.objects.push({
                    "gid": gid,
                    "height": parent.tileheight,
                    "id": this.objects.length + 1,
                    // FIXME: This assumes one tile per tileset.
                    // It might be better to use the name for lookup.
                    "name": parent.tilesets.find((tileset) => tileset.firstgid === gid)["name"],
                    "rotation": 0,
                    "type": "",
                    "visible": true,
                    "width": parent.tilewidth,
                    "x": x * parent.tilewidth,
                    "y": y * parent.tileheight
                });
            }

            bitblt(dx, dy, source) {
                for (let x = 0; x <= source[0].length; x++) {
                    for (let y = 0; y <= source.length; y++) {
                        if (source[x]?.[y] !== undefined) {
                            this.addObject(source[x][y], dx + y, dy + x);
                        }
                    }
                }

                return this;
            }
        }

        this.layers.push(new ObjectLayer(name));

        this.nextlayerid += 1;

        return this.layers.at(-1);
    }
}

export function load(scene: Scene, module, objectMap, options = { "useGridEngine": true, "useBitECS": false }) {
    const [[name, tilemap]] = Object.entries<Tilemap>(module);

    console.log(JSON.stringify(tilemap, function(key, value) {
        if (Array.isArray(value) && value.every((value) => typeof value === "number")) {
            return "[" + value.join(", ") + "]";
        }

        return value;
    }, 4).replace(/"\[/g, '[').replace(/\]"/g, ']').replace(/\\""/g, '"').replace(/\\"/g, '"'));

    scene.cache.tilemap.add(name, { "format": Phaser.Tilemaps.Formats.TILED_JSON, "data": tilemap })
    const tilemapInstance = scene.cache.tilemap.add(name, Phaser.Tilemaps.ParseToTilemap(scene, name, tilemap.tilewidth, tilemap.tileheight, tilemap.width, tilemap.height)).get(name)

    for (const { name, image } of tilemap.tilesets) {
        scene.load.image(name, image);

        scene.load.once("filecomplete-image-" + name, function(key, type, data) {
            tilemapInstance.addTilesetImage(name);
        });
    }

    scene.load.once("complete", function(loader, totalComplete, totalFailed) {
        for (const { name } of tilemapInstance.layers) {
            tilemapInstance.createLayer(name, tilemapInstance.tilesets);
        }

        for (const { objects, properties } of tilemap.layers) {
            if (objects === undefined) {
                continue;
            }

            if (options["useGridEngine"]) {
                scene.events.once("preupdate", function() {
                    const characters = [];

                    const objectCount = {};

                    for (const { name, x, y } of objects) {
                        objectCount[name] ??= 1;

                        characters.push({
                            ...Object.fromEntries(tilemap.tilesets.map(({ name }) => [name, objectMap[name]]))[name],
                            "id": (objectCount[name] -= 1) ? name + objectCount[name] : name,
                            "sprite": scene.add.sprite(0, 0, name),
                            "startPosition": {
                                "x": x / tilemap.tilewidth,
                                "y": y / tilemap.tileheight
                            },
                            "charLayer": properties?.find((property) => property.name === "ge_charLayer")["value"] ?? tilemapInstance.layers.at(-1)["name"]
                        });

                        if (options.useBitECS) {
                            const entity = scene.world.addEntity();

                            entity.set(scene.components.position, "x", x);
                            entity.set(scene.components.position, "y", y);

                            //scene.entities[name][objectCount[name]] = entity;
                        }
                    }

                    scene.gridEngine.create(scene.cache.tilemap.get(name), {
                        "characters": characters,
                        "characterCollisionStrategy": CollisionStrategy.BLOCK_ONE_TILE_AHEAD,
                    });
                });
            } else {
                throw new Error("Not implemented.");
            }
        }
    });

    return tilemapInstance;
}
