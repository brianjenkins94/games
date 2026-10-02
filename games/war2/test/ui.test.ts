/**
 * The command card (W3c): what each selection's card holds (ui/abilities.ts, from the game's data), and what pressing
 * it does (ui/commandCardController.ts) — a navigation stack of menus, with targeting and placement on top — down to
 * the commands it emits. Pure, so tested here; the browser tests drive it through the HUD.
 */
import type { Command } from "../src/sim/command.ts";
import type { CommandCard } from "../src/ui/abilities.ts";
import type { PlacementGhost } from "../src/ui/commandCardController.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CmdType } from "../src/sim/command.ts";
import { fpToTile, tileCenterFP } from "../src/sim/components.ts";
import { unitTypeId } from "../src/sim/unitTypes.ts";
import { commandCardFor, factionOf } from "../src/ui/abilities.ts";
import { createCommandCardController } from "../src/ui/commandCardController.ts";

const ids = (card: CommandCard | null) => card?.map((ability) => ability?.id ?? null) ?? null;

test("a selection's card comes from the game's data: workers move, fight and build; halls train; a build menu lists the buildings", () => {
	assert.deepEqual(ids(commandCardFor("unit-peasant")), ["move", "stop", "attack", "patrol", "hold", "repair", "build-basic", null, null]);
	assert.deepEqual(ids(commandCardFor("unit-footman")), ["move", "stop", "attack", "patrol", "hold", null, null, null, null]);
	assert.deepEqual(ids(commandCardFor("unit-town-hall")), ["train:unit-peasant", "upgrade:unit-keep", null, null, null, null, null, null, null]);
	assert.equal(ids(commandCardFor("unit-peasant", "build"))!.at(-1), "cancel");
	assert.ok(ids(commandCardFor("unit-peon", "build"))!.includes("build:unit-pig-farm"));
	assert.deepEqual([factionOf("unit-peon"), factionOf("unit-peasant")], ["orc", "human"]);

	for (const type of ["unit-peasant", "unit-footman", "unit-town-hall"]) {
		const keys = commandCardFor(type).flatMap((ability) => (ability !== null && ability.hotkey.length === 1 ? [ability.hotkey] : []));

		assert.equal(new Set(keys).size, keys.length, `${type}'s hotkeys are unique`);
	}
});

function harness(selection: number[], { building }: { "building"?: number } = {}) {
	const emitted: Command[] = [];
	const shown: (CommandCard | null)[] = [];
	const ghosts: (PlacementGhost | null)[] = [];
	let cursor = false;
	const controller = createCommandCardController({
		"getOwnSelection": () => selection,
		"getRallyableBuildingUid": () => building,
		"snapToTile": (fp) => fp,
		"emit": (command) => { emitted.push(command); },
		"render": (card) => { shown.push(card); },
		"setTargetingCursor": (on) => { cursor = on; },
		"myTeam": 1,
		"fpToTile": fpToTile,
		"canPlaceBuilding": (tileX) => tileX >= 0,
		"showPlacementGhost": (ghost) => { ghosts.push(ghost); }
	});

	return { "controller": controller, "emitted": emitted, "shown": shown, "ghosts": ghosts, "cursor": () => cursor };
}

test("right-click moves the selection (shift queues it); with a training building selected, it sets the rally point", () => {
	const units = harness([3, 4]);

	units.controller.setSelection("unit-footman");
	units.controller.secondaryClick(1000, 2000);
	units.controller.secondaryClick(3000, 4000, true);
	assert.deepEqual(units.emitted, [{ "type": CmdType.MOVE, "unitIds": [3, 4], "txFP": 1000, "tyFP": 2000 }, { "type": CmdType.MOVE, "unitIds": [3, 4], "txFP": 3000, "tyFP": 4000, "queue": true }]);

	const hall = harness([9], { "building": 9 });

	hall.controller.setSelection("unit-town-hall");
	hall.controller.secondaryClick(5000, 6000);
	assert.deepEqual(hall.emitted, [{ "type": CmdType.SET_RALLY, "buildingUid": 9, "txFP": 5000, "tyFP": 6000, "team": 1 }]);
});

test("the card is a navigation stack: B opens the build menu, F arms a farm's placement, a click places it, Escape backs out a level at a time", () => {
	const { controller, emitted, shown, ghosts, cursor } = harness([5]);
	const farm = unitTypeId("unit-farm");

	controller.setSelection("unit-peasant");
	assert.equal(controller.hotkey("b"), true);
	assert.equal(ids(shown.at(-1))![0], "build:unit-farm");
	assert.equal(controller.hotkey("f"), true);
	assert.equal(cursor(), true, "placing: the crosshair");

	controller.hoverTile(tileCenterFP(7), tileCenterFP(7));
	assert.deepEqual(ghosts.at(-1), { "tileX": 6, "tileY": 6, "fw": 2, "fh": 2, "valid": true });
	assert.equal(controller.primaryClick(tileCenterFP(7), tileCenterFP(7)), true, "the click is taken: no selection change");
	assert.deepEqual(emitted, [{ "type": CmdType.BUILD, "typeId": farm, "team": 1, "tileX": 6, "tileY": 6 }]);
	assert.equal(ghosts.at(-1), null);
	assert.equal(controller.primaryClick(0, 0), false, "placed: clicks select again");

	controller.escape();
	assert.equal(ids(shown.at(-1))![0], "move", "Escape: back to the root card");
	assert.equal(controller.hotkey("q"), false, "a letter no slot owns isn't taken");
});

test("an invalid spot keeps the placement armed; right-click cancels it without moving; M arms a move that a click aims", () => {
	const { controller, emitted, cursor } = harness([5]);

	controller.setSelection("unit-peasant");
	controller.hotkey("b");
	controller.hotkey("f");
	assert.equal(controller.primaryClick(-100_000, 0), true);
	assert.deepEqual(emitted, [], "nothing placed off the map");
	controller.secondaryClick(1, 1);
	assert.deepEqual(emitted, [], "the right-click only cancelled");
	assert.equal(cursor(), false);

	controller.escape();
	controller.hotkey("m");
	assert.equal(controller.isTargeting(), true);
	controller.primaryClick(7000, 8000);
	assert.deepEqual(emitted, [{ "type": CmdType.MOVE, "unitIds": [5], "txFP": 7000, "tyFP": 8000 }]);
});

test("a hall's card trains its worker: PRODUCE at the selected building", () => {
	const { controller, emitted } = harness([9], { "building": 9 });

	controller.setSelection("unit-great-hall");
	controller.slot(0);
	assert.deepEqual(emitted, [{ "type": CmdType.PRODUCE, "buildingUid": 9, "productTypeId": unitTypeId("unit-peon"), "team": 1 }]);
});
