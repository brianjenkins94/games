import { defineSystem, defineQuery } from "../../../util/phaser/bitecs";
import { Direction } from "../schemas/direction";

export function createInputSystem(scene, [MoveIntent]) {
  const query = defineQuery([MoveIntent]);
  const cursors = scene.input.keyboard.createCursorKeys();

  return defineSystem((world) => {
    for (const eid of query(world)) {
      if (cursors.up.isDown) {
        MoveIntent.set(eid, "direction", Direction.Up);
      } else if (cursors.right.isDown) {
        MoveIntent.set(eid, "direction", Direction.Right);
      } else if (cursors.down.isDown) {
        MoveIntent.set(eid, "direction", Direction.Down);
      } else if (cursors.left.isDown) {
        MoveIntent.set(eid, "direction", Direction.Left);
      }
    }

    return world;
  });
}
