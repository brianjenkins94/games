import { createWorld, addComponent } from "bitecs";
import { load } from "../../util/phaser/Tilemap";
import { level1 } from "./levels/level1";

import { inputSystem }    from "./systems/input";
import { movementSystem } from "./systems/movement";
import { renderSystem }   from "./systems/render";
import { winSystem }      from "./systems/win";

import { Position }   from "./schemas/position";
import { MoveIntent } from "./schemas/moveIntent";
import { Player }     from "./schemas/player";
import { Pushable }   from "./schemas/pushable";
import { Target }     from "./schemas/target";

export const name = "level1";

export function init(_scene) {}

export function preload(scene) {
    scene.world = createWorld();

    function setPosition(eid: number, tx: number, ty: number) {
        addComponent(scene.world, eid, Position);
        Position.x[eid] = tx;
        Position.y[eid] = ty;
    }

    load(scene, "level1", level1, {
        "player":  { components: [MoveIntent, Player], onSpawn: setPosition },
        "boulder": { components: [Pushable],           onSpawn: setPosition },
        "target":  { components: [Target],             onSpawn: setPosition },
    });
}

export function create(scene) {
    const { mapWidth, mapHeight } = scene.world.tileConfig;
    scene.game.scale.setGameSize(mapWidth, mapHeight);

    // Keyboard cursors live on the world so systems only need `world`.
    scene.world.cursors = scene.input.keyboard!.createCursorKeys();
    scene.world.onWin   = () => console.log("You win!");

    scene.systems = [inputSystem, movementSystem, renderSystem, winSystem];
}

export function preupdate(_scene) {}

export function update(scene, _time, _delta) {
    for (const system of scene.systems) {
        system(scene.world);
    }
}
