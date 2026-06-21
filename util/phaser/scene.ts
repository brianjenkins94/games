/**
 * Functional Phaser scenes.
 *
 * Instead of subclassing `Phaser.Scene`, a game is a plain module of free functions — `init`, `preload`,
 * `preupdate`, `create`, `update` — each taking the scene as its first argument.  This keeps game logic
 * decoupled from Phaser's class machinery (the functions are trivially unit-testable and shareable).
 *
 * `createScene` turns such a module into the scene factory Phaser's game config expects, replacing the
 * hand-rolled `scene: function() { … }` block each game's index.html used to carry (see games/dozer).
 */
import Phaser from "phaser";

// The scene carries a couple of convenience bags games hang state on.  `systems` is the per-tick system
// list update() runs; `components` is a free-form registry.  (`world` is declared by Tilemap.ts.)
declare module "phaser" {
    interface Scene {
        components: Record<string, unknown>;
        systems: ((world: any) => void)[];
    }
}

/**
 * A game expressed as lifecycle functions.  Every hook is optional except a `name` (the scene key).
 * Each receives the live `Phaser.Scene`; `init`/`preload`/`create` also forward Phaser's own args.
 */
export interface GameModule {
    /** Scene key. */
    name: string;
    init?:      (scene: Phaser.Scene, ...args: any[]) => void;
    preload?:   (scene: Phaser.Scene, ...args: any[]) => void;
    /** Runs once, on the first `preupdate` after `preload` — for setup that needs loaded assets. */
    preupdate?: (scene: Phaser.Scene) => void;
    create?:    (scene: Phaser.Scene, ...args: any[]) => void;
    update?:    (scene: Phaser.Scene, time: number, delta: number) => void;
}

/**
 * Build a Phaser scene factory from a game module.  Returns the `() => Phaser.Scene` callback Phaser's
 * config expects: it constructs a bare `Phaser.Scene(name)`, seeds the `components`/`systems` bags, and
 * points each lifecycle hook at the module's function (injecting the scene).  `preupdate` is fired once,
 * after the first `preload`, via Phaser's `preupdate` event.
 */
export function createScene(mod: GameModule): () => Phaser.Scene {
    return () => {
        const scene = new Phaser.Scene(mod.name);
        scene.components = {};
        scene.systems = [];

        scene.init = (...args: any[]) => mod.init?.(scene, ...args);
        scene.preload = (...args: any[]) => {
            mod.preload?.(scene, ...args);
            if (mod.preupdate) scene.events.once("preupdate", () => mod.preupdate!(scene));
        };
        scene.create = (...args: any[]) => mod.create?.(scene, ...args);
        scene.update = (time: number, delta: number) => mod.update?.(scene, time, delta);

        return scene;
    };
}
