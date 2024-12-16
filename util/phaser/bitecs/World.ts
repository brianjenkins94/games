import * as bitecs from "bitecs";

import { Component } from "./Component";

export function createWorld() {
    const world = bitecs.createWorld();

    return {
        "world": world,
        defineComponent: bitecs.defineComponent
    }
}
