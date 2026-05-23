import { query } from "bitecs";
import { MoveIntent } from "../schemas/moveIntent";
import { Direction } from "../schemas/direction";

export function inputSystem(world) {
    const { cursors } = world;

    for (const eid of query(world, [MoveIntent])) {
        if (Phaser.Input.Keyboard.JustDown(cursors.up)) {
            MoveIntent.direction[eid] = Direction.Up;
        } else if (Phaser.Input.Keyboard.JustDown(cursors.right)) {
            MoveIntent.direction[eid] = Direction.Right;
        } else if (Phaser.Input.Keyboard.JustDown(cursors.down)) {
            MoveIntent.direction[eid] = Direction.Down;
        } else if (Phaser.Input.Keyboard.JustDown(cursors.left)) {
            MoveIntent.direction[eid] = Direction.Left;
        }
    }
}
