import * as bitecs from "bitecs"

export * from "bitecs";

export class Component {
    private _world;
    private _component;

    constructor(world, schema) {
        this._world = world;
        this._component = bitecs.defineComponent(schema)
    }

    get(entity, property) {
        return this._world[this._component][property][entity]
    }

    set(entity, property, value) {
        return this._world[this._component][property][entity] = value;
    }
}

export class Entity {
    private _world;
    private _id;

    constructor(world) {
        this._world = world;
        this._id = bitecs.addEntity(this._world);
    }

    addComponent(component) {
        bitecs.addComponent(this._world, component, this._id);
    }

    get(component, property) {
        return component[property][this._id]
    }

    set(component, property, value) {
        return component[property][this._id] = value
    }
}

export function addEntity(world) {
    return new Entity(world);
}
