import { defineSystem, defineQuery } from "../../../util/phaser/bitecs"

import { Direction } from "../schemas/input";
import { Direction as GridEngineDirection } from "../../../util/phaser/grid-engine/src/GridEngine";

export function createPlayerSystem(scene, components) {
    const playerQuery = defineQuery(components);

    function handleMovement(entity, direction) {
        scene.gridEngine.turnTowards(entity, direction)

        let { x, y } = scene.gridEngine.getFacingPosition(entity);

        const [boulder] = scene.gridEngine.getCharactersAt({ x, y }, "layer1")
            .filter((object) => object.startsWith("boulder"));

        if (boulder !== undefined) {
            if (direction === Direction.Up) {
                y -= 1
            } else if (direction === Direction.Right) {
                x += 1
            } else if (direction === Direction.Down) {
                y += 1
            } else if (direction === Direction.Left) {
                x -= 1
            }

            scene.gridEngine.move(boulder, direction);

            scene.gridEngine.move(entity, direction);
        } else if (!scene.gridEngine.isTileBlocked({ x, y }, "layer1")) {
            scene.gridEngine.move(entity, direction);
        }
    }

    return defineSystem(function(world) {
        const cursors = scene.input.keyboard.createCursorKeys()

        for (const entity of playerQuery(world)) {
            if (cursors.up.isDown) {
                handleMovement("player", GridEngineDirection.UP);
            } else if (cursors.right.isDown) {
                handleMovement("player", GridEngineDirection.RIGHT);
            } else if (cursors.down.isDown) {
                handleMovement("player", GridEngineDirection.DOWN);
            } else if (cursors.left.isDown) {
                handleMovement("player", GridEngineDirection.LEFT);
            }
        }

        return world;
    })
}
