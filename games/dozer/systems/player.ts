import { defineSystem, defineQuery } from "../../../util/phaser/bitecs"

import { Direction } from '../schemas/input'

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

            if (scene.gridEngine.isTileBlocked({ x, y }, "layer1")) {
                console.log("Cannot not move " + direction + ". There is an object in the way.");

                return;
            }

            scene.gridEngine.move(boulder, direction);

            scene.gridEngine.move(entity, direction);
        } else {
            if (!scene.gridEngine.isTileBlocked({ x, y }, "layer1")) {
                scene.gridEngine.move(entity, direction);
            } else {
                console.log("Cannot move " + direction + ". It is blocked.");

                console.log(scene.gridEngine.getCharactersAt({ x, y }, "layer1"))
            }
        }
    }

    return defineSystem(function(world) {
        const cursors = scene.input.keyboard.createCursorKeys()

        for (const entity of playerQuery(world)) {
            if (cursors.up.isDown) {
                handleMovement(entity, Direction.UP);
            } else if (cursors.right.isDown) {
                handleMovement(entity, Direction.RIGHT);
            } else if (cursors.down.isDown) {
                handleMovement(entity, Direction.DOWN);
            } else if (cursors.left.isDown) {
                handleMovement(entity, Direction.LEFT);
            }
        }

        return world;
    })
}
