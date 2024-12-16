import * as bitecs from "bitecs";

export class Component {
    private _world;
    private _component;

    constructor(world, schema) {
        this._world = world;
        this._component = bitecs.defineComponent(schema)
    }

    addTo(entity) {
        bitecs.addComponent(this._world, this._component, entity);

        return this._component;
    }

    get(entity, property) {
        return this._world[this._component][property][entity]
    }

    set(entity, property, value) {
        return this._world[this._component][property][entity] = value;
    }
}
