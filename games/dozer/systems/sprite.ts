import Phaser from "phaser"
import { defineSystem, defineQuery, enterQuery, exitQuery } from "bitecs";

export function createSpriteSystem(scene: Phaser.Scene, components) {

    const spriteQuery = defineQuery(components)
    const spriteQueryEnter = enterQuery(spriteQuery)
    const spriteQueryExit = exitQuery(spriteQuery)

    return defineSystem(function({ world }) {
        for (const entity of spriteQueryEnter(world)) {
            const texId = scene.components.sprite.get(entity, "texture"); //Sprite.texture[entity];
            debugger;
            const texture = textures[texId];

            spritesMap.set(entity, scene.add.sprite(0, 0, texture))
        }

        for (const entity of spriteQuery(world)) {
            const sprite = spritesMap.get(entity)

            sprite.x = Position.x[entity]
            sprite.y = Position.y[entity]
        }

        for (const entity of spriteQueryExit(world)) {
            spritesMap.delete(entity);
        }

        return world
    })
}
