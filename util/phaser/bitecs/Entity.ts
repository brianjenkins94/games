export class Entity {
    private _id;

    constructor(id) {
        this._id = id;
    }

    get(component, property) {
        if (component["_component"] !== undefined) {
            component = component["_component"]
        }

        return component[property][this._id]
    }

    set(component, property, value) {
        if (component["_component"] !== undefined) {
            component = component["_component"]
        }

        return component[property][this._id] = value
    }
}
