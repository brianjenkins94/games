/** The oracle's runner for the old sim, frozen in ../../legacy (see adapter.ts). */
import * as components from "../../legacy/src/game/components.ts";
import * as game from "../../legacy/src/game/game.ts";
import * as unitTypes from "../../legacy/src/game/unitTypes.ts";
import * as vision from "../../legacy/src/game/vision.ts";
import { adapter } from "./adapter.ts";

export const runLegacy = adapter({ "components": components, "game": game, "unitTypes": unitTypes, "vision": vision } as unknown as Parameters<typeof adapter>[0]);
