import { createWorld } from "../../util/phaser/bitecs";
//import { GridEngine } from "../../util/phaser/grid-engine/src/GridEngine";
import { Component } from "../../util/phaser/bitecs";

import { load } from '../../util/phaser/Tilemap';
import { createInputSystem } from "./systems/input";
import { createMoveIntentSystem } from "./systems/moveIntent";
//import { createWinSystem } from "./systems/win";

import * as moveIntent from "./schemas/moveIntent";
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
        "moveIntent": new Component(scene.world, moveIntent.schema)
        //"goal": new Component(scene.world, goal.schema),
        //"solved": new Component(scene.world, solved.schema)
    };

    // TODO: Remove `require()`
    load(scene, require("./levels/level1"), {
        "player": {
            "collides": {
                "collisionGroups": ["a"]
            },
            "components": ["moveIntent"]
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
        createInputSystem(scene, [scene.components.moveIntent]),
        createMoveIntentSystem(scene, [scene.components.moveIntent]),
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
