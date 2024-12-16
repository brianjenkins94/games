import { defineSystem, defineQuery } from "bitecs"

import { Direction } from '../schemas/input'

export function createPlayerSystem(scene, components) {
    const playerQuery = defineQuery(components)

    return defineSystem(function({ world }) {
        const cursors = scene.input.keyboard.createCursorKeys()

        function handleMovement(object, direction) {

            scene.gridEngine.turnTowards(object, direction)

            let { x, y } = scene.gridEngine.getFacingPosition("player");

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

                scene.gridEngine.move("player", direction);
            } else {
                if (!scene.gridEngine.isTileBlocked({ x, y }, "layer1")) {
                    scene.gridEngine.move("player", direction);
                } else {
                    console.log("Cannot move " + direction + ". It is blocked.");

                    console.log(scene.gridEngine.getCharactersAt({ x, y }, "layer1"))
                }
            }
        }

        for (const entity of playerQuery(world)) {
            if (cursors.up.isDown) {
                handleMovement("player", Direction.UP);
            } else if (cursors.right.isDown) {
                handleMovement("player", Direction.RIGHT);
            } else if (cursors.down.isDown) {
                handleMovement("player", Direction.DOWN);
            } else if (cursors.left.isDown) {
                handleMovement("player", Direction.LEFT);
            }
            if (cursors.left.isDown) {
                Input.direction[entity] = Direction.Left
            }
            else if (cursors.right.isDown) {
                Input.direction[entity] = Direction.Right
            }
            else if (cursors.up.isDown) {
                Input.direction[entity] = Direction.Up
            }
            else if (cursors.down.isDown) {
                Input.direction[entity] = Direction.Down
            }
            else {
                Input.direction[entity] = Direction.None
            }
        }

        return world
    })
}
