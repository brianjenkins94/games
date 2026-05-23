import { defineSystem, defineQuery } from "../../../util/phaser/bitecs";
import { Direction } from "../schemas/direction";

export function createInputSystem(scene, [MoveIntent]) {
    const query = defineQuery([MoveIntent]);
    const cursors = scene.input.keyboard.createCursorKeys();

    return defineSystem(function(world) {
        for (const eid of query(world)) {
            // JustDown fires exactly once per keypress — correct for a turn-based puzzle.
            if (Phaser.Input.Keyboard.JustDown(cursors.up)) {
                MoveIntent.set(eid, "direction", Direction.Up);
            } else if (Phaser.Input.Keyboard.JustDown(cursors.right)) {
                MoveIntent.set(eid, "direction", Direction.Right);
            } else if (Phaser.Input.Keyboard.JustDown(cursors.down)) {
                MoveIntent.set(eid, "direction", Direction.Down);
            } else if (Phaser.Input.Keyboard.JustDown(cursors.left)) {
                MoveIntent.set(eid, "direction", Direction.Left);
            }
        }

        return world;
    });
}
