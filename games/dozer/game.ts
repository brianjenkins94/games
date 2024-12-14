import { Scene } from 'phaser';
import { loadLevel1 } from './levels/level1';
import { GridEngine, Direction } from "../../util/phaser/grid-engine/src/GridEngine"

// Development build of GridEngine
globalThis.GridEngine = GridEngine;

// https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation
declare module "phaser" {
    interface Scene {
        init?: () => void;
        preload?: () => void;
        create?: () => void;
        gridEngine: GridEngine;
    }
}

export const scene = new Scene("Game");

scene.init = function () {
    console.log("init!");
}

scene.preload = function () {
    const { width, height, tileWidth, tileHeight } = loadLevel1(scene, {
        "player": {
            "collides": {
                "collisionGroups": ["a"]
            }
        },
        "boulder": {
            "collides": {
                "collisionGroups": ["a"]
            }
        }
    })

    scene.events.once("preupdate", function() {
        scene.game.scale.setGameSize(width * tileWidth, height * tileHeight)
    });
}

scene.create = function () {
    // Win Condition

    scene.time.addEvent({
        "delay": 500,
        "callback": function evaluateWinCondition() {
            const targets = scene.gridEngine.getAllCharacters()
                .filter((character) => character.startsWith("target"))
                .map(scene.gridEngine.getPosition, scene.gridEngine);

            if (targets.every((target) => scene.gridEngine.getCharactersAt(target, "layer1").some((character) => character.startsWith("boulder")))) {
                alert("YOU FUCKING WON!!!")

                this.remove();
            }
        },
        "loop": true
    });
}

scene.update = function (time, delta) {
    // Character Movement

    const cursors = scene.input.keyboard.createCursorKeys();

    function handleMovement(object, direction) {
        scene.gridEngine.turnTowards(object, direction)

        let { x, y } = scene.gridEngine.getFacingPosition("player");

        const [boulder] = scene.gridEngine.getCharactersAt({ x, y }, "layer1")
            .filter((object) => object.startsWith("boulder"));

        if (boulder !== undefined) {
            if (direction === Direction.UP) {
                y -= 1
            } else if (direction === Direction.RIGHT) {
                x += 1
            } else if (direction === Direction.DOWN) {
                y += 1
            } else if (direction === Direction.LEFT) {
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

    if (cursors.up.isDown) {
        handleMovement("player", Direction.UP);
    } else if (cursors.right.isDown) {
        handleMovement("player", Direction.RIGHT);
    } else if (cursors.down.isDown) {
        handleMovement("player", Direction.DOWN);
    } else if (cursors.left.isDown) {
        handleMovement("player", Direction.LEFT);
    }

}
