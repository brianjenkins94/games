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
                if (source[x][y] !== undefined) {
                    this.data[((dy + x) * this.width) + dx + y] = source[x][y];
                }
            }
        }

        return this;
    }
}

export class Tilemap {
    compressionlevel = -1;
    height = 12;
    infinite = false;
    layers = [];
    nextlayerid = 1;
    nextobjectid = 1;
    orientation = "orthogonal";
    renderorder = "right-down";
    tiledversion = "1.11.0";
    tileheight = 32;
    tilesets = [];
    tilewidth = 32;
    type = "map";
    version = "1.10";
    width = 20;

    constructor(width, height, tileWidth = 32, tileHeight = 32) {
        this.width = width;
        this.height = height;
        this.tilewidth = tileWidth;
        this.tileheight = tileHeight;
    }

    addTileset(name, imagePath, tileProperties = []) {
        this.tilesets.push({
            "columns": 1,
            "firstgid": this.tilesets.length + 1, // [!] This doesn't account for multiple tiles per set
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
                        if (source[x][y] !== undefined) {
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
