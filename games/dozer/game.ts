import { createWorld } from "../../util/phaser/bitecs";
//import { GridEngine } from "../../util/phaser/grid-engine/src/GridEngine";
import { Component } from "../../util/phaser/bitecs";

import { load } from '../../util/phaser/Tilemap';
import { createPlayerSystem } from "./systems/player";
import { createSpriteSystem } from "./systems/sprite";
//import { createWinSystem } from "./systems/win";

import * as position from "./schemas/position";
import * as sprite from "./schemas/sprite";
import * as player from "./schemas/player";
//import * as goal from "./schemas/goal";
//import * as solved from "./schemas/solved";

// Development build of GridEngine
//globalThis.GridEngine = GridEngine;

export const name = "level1";

export function init(scene) {
    console.log("init!");
}

export function preload(scene) {
    scene.world = createWorld();
    scene.__won = false;
    scene.sprites = {};

    scene.components = {
        "position": new Component(scene.world, position.schema),
        "sprite": new Component(scene.world, sprite.schema),
        "player": new Component(scene.world, player.schema),
        //"goal": new Component(scene.world, goal.schema),
        //"solved": new Component(scene.world, solved.schema)
    };

    // TODO: Remove `require()`
    scene._tilemapData = load(scene, require("./levels/level1"), {
        "player": {
            "collides": {
                "collisionGroups": ["a"]
            },
            "components": ["player"]
        },
        "boulder": {
            "collides": {
                "collisionGroups": ["a"]
            }
        },
        "target": {
            "components": [/* "goal" */]
        }
    });
}

export function create(scene) {
    scene.systems = [
        createPlayerSystem(scene, [scene.components.player]),
        createSpriteSystem(scene, [scene.components.position, scene.components.sprite]),
        //createWinSystem(scene, [scene.components.goal, scene.components.solved])
    ];
}

export function preupdate(scene) {
    const { width, height, tileWidth, tileHeight } = scene.cache.tilemap.get(scene.sys.config);

    scene.game.scale.setGameSize(width * tileWidth, height * tileHeight);
}

export function update(scene, time, delta) {
    for (const system of scene.systems) {
        system(scene.world);
    }
}
