import * as bitecs from "bitecs"

export * from "bitecs";

export class Component {
    private _world;
    // Public so defineQuery can unwrap it; treat as internal.
    readonly component;

    constructor(world, schema) {
        this._world = world;
        this.component = bitecs.defineComponent(schema);
    }

    get(entity, property) {
        return this.component[property][entity];
    }

    set(entity, property, value) {
        this.component[property][entity] = value;
    }

    has(entity) {
        return bitecs.hasComponent(this._world, this.component, entity);
    }

    add(entity) {
        return bitecs.addComponent(this._world, this.component, entity);
    }

    remove(entity) {
        return bitecs.removeComponent(this._world, this.component, entity);
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

    addComponent(component: Component) {
        // Route through Component.add so bitecs sees this.component (not the wrapper).
        component.add(this._id);
    }

    get(component: Component, property) {
        return component.component[property][this._id];
    }

    set(component: Component, property, value) {
        return component.component[property][this._id] = value;
    }
}

export function addEntity(world) {
    return new Entity(world);
}

// Shadow the re-exported defineQuery so Component instances are unwrapped
// before being handed to bitecs, which expects its own raw component objects.
export function defineQuery(components: Component[]) {
    return bitecs.defineQuery(components.map(c => c instanceof Component ? c.component : c));
}
