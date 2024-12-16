import { defineSystem, defineQuery } from "bitecs";

import { Direction } from '../schemas/input'

export function createOrientationSystem(components) {
    const orientationQuery = defineQuery(components)

    return defineSystem(function({ world }) {
        for (const entity of orientationQuery(world)) {
            const direction = Input.direction[entity]

            switch (direction) {
                case Direction.Left:
                    Orientation.angle[entity] = 180
                    break

                case Direction.Right:
                    Orientation.angle[entity] = 0
                    break

                case Direction.Up:
                    Orientation.angle[entity] = 270
                    break

                case Direction.Down:
                    Orientation.angle[entity] = 90
                    break
            }

            //Position.x[id] += Velocity.x[id]
            //Position.y[id] += Velocity.y[id]
        }

        return world
    })
}
