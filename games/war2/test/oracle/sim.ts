/** The oracle's runner for the new sim, in ../../src/sim (see adapter.ts): everything it reads is on the game's world. */
import { tileCenterFP } from "../../src/sim/components.ts";
import { createGame } from "../../src/sim/game.ts";
import { unitTypeId, unitTypeName } from "../../src/sim/unitTypes.ts";
import { exportExplored, revealAll } from "../../src/sim/vision.ts";
import { adapter } from "./adapter.ts";

export const runSim = adapter({
	"createGame": createGame,
	"components": (game) => game.world.components,
	"exportExplored": (game) => exportExplored(game.world),
	"revealAll": (game) => { revealAll(game.world); },
	"tileCenterFP": tileCenterFP,
	"unitTypeId": unitTypeId,
	"unitTypeName": unitTypeName
});
