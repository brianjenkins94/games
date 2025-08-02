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
        return this._component[property][entity]
    }

    set(entity, property, value) {
        this._component[property][entity] = value;
    }

    has(entity) {
        return bitecs.hasComponent(this._world, this._component, entity);
    }

    add(entity) {
        return bitecs.addComponent(this._world, this._component, entity);
    }
}

export class Entity {
    private _world;
    private _id;

    constructor(world) {
        this._world = world;
        this._id = bitecs.addEntity(this._world);
    }

    get id() {
        return this._id;
    }

    addComponent(component) {
        bitecs.addComponent(this._world, component, this._id);
    }

    get(component, property) {
        return component._component[property][this._id]
    }

    set(component, property, value) {
        return component._component[property][this._id] = value
    }
}

export function addEntity(world) {
    return new Entity(world);
}
