import Phaser from "phaser"
import { defineSystem, defineQuery, enterQuery, exitQuery } from "../../../util/phaser/bitecs";

export function createSpriteSystem(scene: Phaser.Scene, components) {
    const spriteQuery = defineQuery(components)
    const spriteQueryEnter = enterQuery(spriteQuery)
    const spriteQueryExit = exitQuery(spriteQuery)

    return defineSystem(function(world) {
        for (const entity of spriteQueryEnter(world)) {
            // We would associate the texture with the object here,
            // but GridEngine maintains that relationship.
        }

        for (const entity of spriteQuery(world)) {
            // onPositionChange()
            //sprite.x = Position.x[id]
            //sprite.y = Position.y[id]
        }

        for (const entity of spriteQueryExit(world)) {
            // Nothing to clean up.
        }

        return world
    })
}
