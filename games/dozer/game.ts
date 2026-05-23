import { createWorld, Component } from "../../util/phaser/bitecs";
import { load } from "../../util/phaser/Tilemap";
import { level1 } from "./levels/level1";

import { createInputSystem }    from "./systems/input";
import { createMovementSystem } from "./systems/movement";
import { createRenderSystem }   from "./systems/render";
import { createWinSystem }      from "./systems/win";

import * as moveIntentSchema from "./schemas/moveIntent";
import * as positionSchema   from "./schemas/position";
import * as playerSchema     from "./schemas/player";
import * as pushableSchema   from "./schemas/pushable";
import * as targetSchema     from "./schemas/target";

export const name = "level1";

export function init(_scene) {}

export function preload(scene) {
    scene.world = createWorld();

    scene.components = {
        moveIntent: new Component(scene.world, moveIntentSchema.schema),
        position:   new Component(scene.world, positionSchema.schema),
        player:     new Component(scene.world, playerSchema.schema),
        pushable:   new Component(scene.world, pushableSchema.schema),
        target:     new Component(scene.world, targetSchema.schema),
    };

    load(scene, "level1", level1, {
        "player":  { components: ["moveIntent", "player"] },
        "boulder": { components: ["pushable"] },
        "target":  { components: ["target"] },
    });
}

export function create(scene) {
    const { moveIntent, position, pushable, target } = scene.components;

    scene.systems = [
        createInputSystem(scene,    [moveIntent]),
        createMovementSystem(scene, [moveIntent, position, pushable]),
        createRenderSystem(scene,   [position]),
        createWinSystem(scene,      [position, pushable, target]),
    ];
}

export function preupdate(scene) {
    const { mapWidth, mapHeight } = scene.tileConfig;
    scene.game.scale.setGameSize(mapWidth, mapHeight);
}

export function update(scene, _time, _delta) {
    for (const system of scene.systems) {
        system(scene.world);
    }
}
