export function convertToCharacters(scene, objects, objectMap) {
    const characters = [];

    const objectCount = {};

    for (const { name, x, y, width, height } of objects) {
        objectCount[name] ??= 1;

        characters.push({
            ...objectMap[name],
            "id": (objectCount[name] -= 1) ? name + objectCount[name] : name,
            "sprite": scene.add.sprite(0, 0, name),
            "startPosition": {
                // FIXME: `width` and `height` are of the tiles, not the tilemap.
                "x": x / width,
                "y": y / height
            },
        });
    }

    return characters;
}
