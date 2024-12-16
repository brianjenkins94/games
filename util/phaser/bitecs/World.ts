import * as bitecs from "bitecs";

import { Entity } from "./Entity";
import { Component } from "./Component";

class World {
    public _world = bitecs.createWorld();

    addEntity() {
        return new Entity(bitecs.addEntity(this._world));
    }

    createComponent(schema) {
        return new Component(this._world, schema)
    }

    get(component, entity, property) {
        return this._world[component][property][entity]
    }

    set(component, entity, property, value) {
        return this._world[component][property][entity] = value;
    }
}

export type IWorld = World;

export function createWorld() {
    return new Proxy(new World(), {
        get: function(target: World, prop, receiver) {
            return target[prop] ?? target._world[prop];
        }
    });
}
