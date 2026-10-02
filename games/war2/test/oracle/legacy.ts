/** The oracle's runner for the old sim, frozen in ../../legacy (see adapter.ts): its components and vision are module
 *  globals, one world per realm. */
import type { Sim } from "./adapter.ts";
import * as components from "../../legacy/src/game/components.ts";
import * as game from "../../legacy/src/game/game.ts";
import * as unitTypes from "../../legacy/src/game/unitTypes.ts";
import * as vision from "../../legacy/src/game/vision.ts";
import { adapter } from "./adapter.ts";

export const runLegacy = adapter({
	"createGame": game.createGame as unknown as Sim["createGame"],
	"components": () => components as unknown as ReturnType<Sim["components"]>,
	"exportExplored": () => vision.exportExplored(),
	"revealAll": () => { vision.revealAll(); },
	"tileCenterFP": components.tileCenterFP,
	"unitTypeId": unitTypes.unitTypeId,
	"unitTypeName": unitTypes.unitTypeName
});
