import { defineSystem, defineQuery } from "../../../util/phaser/bitecs";
import { Direction } from "../schemas/direction";
import { Direction as GridEngineDirection } from "../../../util/phaser/grid-engine/src/GridEngine";

const directionMap = [
  GridEngineDirection.UP,    // 0
  GridEngineDirection.RIGHT, // 1
  GridEngineDirection.DOWN,  // 2
  GridEngineDirection.LEFT   // 3
];

export function createMoveIntentSystem(scene, [MoveIntent]) {
  const intentQuery = defineQuery([MoveIntent]);

  function handleMovement(eid, direction) {
    const charId = scene.entityMap?.[eid];
    if (!charId) return;

    scene.gridEngine.turnTowards(charId, directionMap[direction]);

    let { x, y } = scene.gridEngine.getFacingPosition(charId);

    const [boulder] = scene.gridEngine
      .getCharactersAt({ x, y }, "layer1")
      .filter((object) => object.startsWith("boulder"));

    if (boulder !== undefined) {
      if (direction === GridEngineDirection.UP) {
        y -= 1;
      } else if (direction === GridEngineDirection.RIGHT) {
        x += 1;
      } else if (direction === GridEngineDirection.DOWN) {
        y += 1;
      } else if (direction === GridEngineDirection.LEFT) {
        x -= 1;
      }

      const blocked =
        scene.gridEngine.isTileBlocked({ x, y }, "layer1") ||
        scene.gridEngine.getCharactersAt({ x, y }, "layer1").length > 0;

      if (!blocked) {
        scene.gridEngine.move(boulder, directionMap[direction]);
        scene.gridEngine.move(charId, directionMap[direction]);
      }
    } else {
      if (!scene.gridEngine.isTileBlocked({ x, y }, "layer1")) {
        scene.gridEngine.move(charId, directionMap[direction]);
      }
    }
  }

  return defineSystem((world) => {
    for (const eid of intentQuery(world)) {
      const dir = MoveIntent.get(eid, "direction");

      if (dir == null || dir === Direction.None || dir > 3) continue;

      handleMovement(eid, dir);

      MoveIntent.set(eid, "direction", Direction.None); // reset
    }

    return world;
  });
}
