import { GridEngine } from "../../util/phaser/grid-engine/src/GridEngine"
import { load } from '../../util/phaser/Tilemap';
import { createOrientationSystem } from "./systems/orientation";
import { createPlayerSystem } from "./systems/player";
import { createSpriteSystem } from "./systems/sprite";
import { createWorld } from "../../util/phaser/bitecs/World";

import * as position from "./schemas/position";
import * as sprite from "./schemas/sprite";
import * as player from "./schemas/player";
import * as orientation from "./schemas/orientation";
import * as input from "./schemas/input";

// Development build of GridEngine
globalThis.GridEngine = GridEngine;

export const name = "level1";

export function init(scene) {
    console.log("init!");
}

export function preload(scene) {
    const { world, defineComponent } = createWorld();
    scene.world = world;

    scene.components.position = defineComponent(position.schema)
    scene.components.sprite = defineComponent(sprite.schema)
    //scene.components.player = defineComponent(player.schema)
    //scene.components.orientation = defineComponent(orientation.schema)
    //scene.components.input = defineComponent(input.schema)

    // TODO: Remove `require()`
    load(scene, require("./levels/level1"), {
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
    });
}

export function create(scene) {
    /*
    scene.systems.player = createPlayerSystem(scene, [
        scene.components.player,
        scene.components.rotation,
        scene.components.input
    ]);

    scene.systems.orientation = createOrientationSystem([
        scene.components.position,
        scene.components.rotation,
        scene.components.input
    ]);
    */

    scene.systems.sprite = createSpriteSystem(scene, [
        scene.components.position,
        scene.components.sprite
    ]);
}

export function preupdate(scene) {
    const { width, height, tileWidth, tileHeight } = scene.cache.tilemap.get(scene.sys.config)

    scene.game.scale.setGameSize(width * tileWidth, height * tileHeight)
}

export function update(scene, time, delta) {
    //scene.systems.player(scene.world)
    //scene.systems.orientation(scene.world)
    scene.systems.sprite(scene.world)

    const targets = scene.gridEngine.getAllCharacters()
        .filter((character) => character.startsWith("target"))
        .map(scene.gridEngine.getPosition, scene.gridEngine);

    if (targets.every((target) => scene.gridEngine.getCharactersAt(target, "layer1").some((character) => character.startsWith("boulder")))) {
        alert("YOU FUCKING WON!!!")
    }
}
