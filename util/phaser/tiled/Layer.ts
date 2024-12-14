export class Layer {
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
    }
}
