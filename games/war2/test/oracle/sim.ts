/** The oracle's runner for the new sim, in ../../src/sim (see adapter.ts). */
import * as components from "../../src/sim/components.ts";
import * as game from "../../src/sim/game.ts";
import * as unitTypes from "../../src/sim/unitTypes.ts";
import * as vision from "../../src/sim/vision.ts";
import { adapter } from "./adapter.ts";

export const runSim = adapter({ "components": components, "game": game, "unitTypes": unitTypes, "vision": vision });
