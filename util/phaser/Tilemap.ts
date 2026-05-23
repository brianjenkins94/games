import { Scene } from "phaser";
import { addEntity, addComponent } from "bitecs";

// https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation
declare module "phaser" {
    interface Scene {
        world: any;
        systems: ((world: any) => void)[];
    }
}

class Layer {
    data: number[];
    height: number;
    id: number;
    name: string;
    opacity = 1;
    type = "tilelayer";
    visible = true;
    width: number;
    x = 0;
    y = 0;
    properties?: object[];

    constructor(name: string, tilemap: Tilemap) {
        this.data = new Array(tilemap.width * tilemap.height).fill(0);
        this.height = tilemap.height;
        this.id = tilemap.nextlayerid;
        this.name = name;
        this.width = tilemap.width;
    }

    addProperty(property: object) {
        this.properties ??= [];
        this.properties.push(property);
        return this;
    }

    fill(gid: number) {
        this.data = this.data.fill(gid);
        return this;
    }

    bitblt(dx: number, dy: number, source: (number | undefined)[][]) {
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
    height: number;
    infinite = false;
    layers: any[] = [];
    nextlayerid = 1;
    nextobjectid = 1;
    orientation = "orthogonal";
    renderorder = "right-down";
    tiledversion = "1.11.0";
    tileheight: number;
    tilesets: any[] = [];
    tilewidth: number;
    type = "map";
    version = "1.10";
    width: number;

    constructor(width: number, height: number, tileWidth = 32, tileHeight = 32) {
        this.width = width;
        this.height = height;
        this.tilewidth = tileWidth;
        this.tileheight = tileHeight;
    }

    addTileset(name: string, imagePath: string, tileProperties: object[] = []) {
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
        });
        this.nextobjectid += 1;
    }

    addLayer(name: string) {
        this.layers.push(new Layer(name, this));
        this.nextlayerid += 1;
        return this.layers.at(-1) as Layer;
    }

    addObjectLayer(name: string) {
        const parent = this;

        class ObjectLayer {
            draworder = "topdown";
            id = 8;
            name: string;
            objects: object[] = [];
            opacity = 1;
            type = "objectgroup";
            visible = true;
            x = 0;
            y = 0;
            properties?: object[];

            constructor(n: string) { this.name = n; }

            addProperty(property: object) {
                this.properties ??= [];
                this.properties.push(property);
                return this;
            }

            addObject(gid: number, x: number, y: number) {
                this.objects.push({
                    "gid": gid,
                    "height": parent.tileheight,
                    // FIXME: This assumes one tile per tileset.
                    // It might be better to use the name for lookup.
                    "id": (this.objects as any[]).length + 1,
                    "name": parent.tilesets.find((ts) => ts.firstgid === gid)["name"],
                    "rotation": 0,
                    "type": "",
                    "visible": true,
                    "width": parent.tilewidth,
                    "x": x * parent.tilewidth,
                    "y": y * parent.tileheight
                });
            }

            bitblt(dx: number, dy: number, source: (number | undefined)[][]) {
                for (let x = 0; x <= source[0].length; x++) {
                    for (let y = 0; y <= source.length; y++) {
                        if (source[x]?.[y] !== undefined) {
                            this.addObject(source[x][y]!, dx + y, dy + x);
                        }
                    }
                }
                return this;
            }
        }

        this.layers.push(new ObjectLayer(name));
        this.nextlayerid += 1;
        return this.layers.at(-1) as ObjectLayer;
    }
}

// entityConfig maps object-layer names to component refs and an optional
// onSpawn callback for setting initial component data (e.g. Position x/y).
export type EntityConfig = Record<string, {
    components?: any[];
    onSpawn?: (eid: number, tx: number, ty: number) => void;
}>;

export function load(
    scene: Scene,
    levelName: string,
    tilemapData: Tilemap,
    entityConfig: EntityConfig
) {
    scene.cache.tilemap.add(levelName, {
        format: Phaser.Tilemaps.Formats.TILED_JSON,
        data: tilemapData
    });

    for (const { name, image } of tilemapData.tilesets) {
        scene.load.image(name, image);
    }

    scene.load.once("complete", function() {
        const world = scene.world;

        // ── Visual tile layers ────────────────────────────────────────────────
        const map = scene.make.tilemap({ key: levelName });

        for (const { name } of tilemapData.tilesets) {
            map.addTilesetImage(name);
        }

        for (const layerData of tilemapData.layers) {
            if (layerData.type !== "tilelayer") continue;
            map.createLayer(layerData.name, map.tilesets);
        }

        // ── Resources on the world ────────────────────────────────────────────
        world.walls = new Set<string>();
        world.sprites = new Map<number, Phaser.GameObjects.Sprite>();
        world.tileConfig = {
            tileWidth:  tilemapData.tilewidth,
            tileHeight: tilemapData.tileheight,
            mapWidth:   tilemapData.width  * tilemapData.tilewidth,
            mapHeight:  tilemapData.height * tilemapData.tileheight,
        };

        // Every non-zero tile outside the background layer is a wall.
        for (const layerData of tilemapData.layers) {
            if (layerData.type !== "tilelayer" || layerData.name === "background") continue;
            for (let i = 0; i < layerData.data.length; i++) {
                if (layerData.data[i] !== 0) {
                    world.walls.add(`${i % layerData.width},${Math.floor(i / layerData.width)}`);
                }
            }
        }

        // ── ECS entity spawning ───────────────────────────────────────────────
        for (const layerData of tilemapData.layers) {
            if (layerData.type !== "objectgroup") continue;

            for (const obj of layerData.objects as any[]) {
                const config = entityConfig[obj.name];
                if (!config) continue;

                const tx = Math.round(obj.x / tilemapData.tilewidth);
                const ty = Math.round(obj.y / tilemapData.tileheight);

                const eid = addEntity(world);

                const sprite = scene.add.sprite(
                    tx * tilemapData.tilewidth  + tilemapData.tilewidth  / 2,
                    ty * tilemapData.tileheight + tilemapData.tileheight / 2,
                    obj.name
                );
                world.sprites.set(eid, sprite);

                for (const component of config.components ?? []) {
                    addComponent(world, eid, component);
                }

                config.onSpawn?.(eid, tx, ty);
            }
        }
    });
}
