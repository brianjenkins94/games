/**
 * The referee's flight recorder (W4, src/diag/recorder.ts), in node: what it keeps of a match's recent past, the
 * incidents it flags (by itself, and by hand), and the fixtures they make — each replaying (src/diag/replay.ts) to
 * exactly the captured world.
 */
import type { Command } from "../src/sim/command.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecorder } from "../src/diag/recorder.ts";
import { replayFixture } from "../src/diag/replay.ts";
import { CmdType } from "../src/sim/command.ts";
import { tileCenterFP } from "../src/sim/components.ts";
import { createGame } from "../src/sim/game.ts";
import { worldHash } from "../src/sim/snapshot.ts";
import { revealAll } from "../src/sim/vision.ts";
import { mapInfo, SCENARIOS } from "./oracle/scenarios.ts";
import { runSim } from "./oracle/sim.ts";

function open() {
	const map = mapInfo({ "rows": Array.from({ "length": 12 }, () => "............") });
	const game = createGame(1, map);

	revealAll(game.world);
	game.initUnitIdCounter(0);

	return { "game": game, "map": map };
}

test("it keeps what happened lately: commands with their ticks and teams, each unit's track, and snapshots to replay from", () => {
	const { game, map } = open();
	const recorder = createRecorder({ "snapEvery": 10, "keep": 3 });
	const uid = game.world.components.UnitId.id[game.spawnUnit(tileCenterFP(1), tileCenterFP(1), 0)];
	const move: Command = { "type": CmdType.MOVE, "unitIds": [uid], "txFP": tileCenterFP(8), "tyFP": tileCenterFP(1) };

	for (let tick = 0; tick < 100; tick += 1) {
		const applied = tick === 15 ? [{ "team": 0, "command": move }] : [];

		game.applyCommands(applied.map((entry) => entry.command));
		game.step();
		recorder.observe(game.world, applied);
	}

	assert.deepEqual(recorder.commands(), [{ "tick": 16, "team": 0, "command": move }]);
	assert.deepEqual(recorder.track(uid).map((entry) => entry.tile[0]), [1, 2, 3, 4, 5, 6, 7, 8], "tile by tile, east");
	assert.deepEqual(recorder.track(999), []);
	assert.deepEqual(recorder.pathologies(), []);

	// Flagged by hand: replays from its oldest snapshot (keep 3 × every 10: tick 80), through what came after.
	const incident = recorder.flag(game.world, "by hand");

	assert.deepEqual([incident.id, incident.baseTick, incident.flagTick, incident.commands.length], ["inc_1", 80, 100, 0]);
	assert.equal(incident.flagHash, worldHash(game.world));
	assert.deepEqual(recorder.incidents().map((summary) => summary.id), ["inc_1"]);
	assert.equal(recorder.incident("inc_9"), undefined);
	assert.equal(recorder.fixture("inc_9", { "map": map, "seed": 1, "teams": 2 }), undefined);

	const fixture = recorder.fixture("inc_1", { "map": map, "seed": 1, "teams": 2 })!;

	assert.deepEqual(fixture.expect, {}, "no focus unit, nothing more to expect than the replay itself");
	assert.equal(replayFixture(fixture, map).faithful, true);

	recorder.reset();
	assert.deepEqual([recorder.commands(), recorder.track(uid)], [[], []], "a reset forgets the past…");
	assert.equal(recorder.incidents().length, 1, "…but not the incidents");
});

test("it flags an incident by itself when the detector sees a stall — once per unit and fault — and the fixture replays it faithfully, the fault again", () => {
	const scenario = SCENARIOS.find((candidate) => candidate.name === "pinch-corridor")!;
	const recorder = createRecorder();

	runSim(scenario, (state, game, applied) => {
		if (state.tick > 0) {
			recorder.observe(game.world, (applied as Command[]).map((command) => ({ "team": 0, "command": command })));
		}
	});

	const auto = recorder.incidents();

	assert.deepEqual(auto.map((incident) => incident.label), ["auto: stalled uid1", "auto: stalled uid2"], "each stalled unit once, a cooldown apart");
	assert.equal(auto[1].flagTick - auto[0].flagTick >= 100, true);

	const fixture = recorder.fixture(auto[0].id, { "map": mapInfo(scenario.map), "seed": scenario.seed, "teams": 2 })!;
	const replay = replayFixture(fixture, mapInfo(scenario.map));

	assert.deepEqual(fixture.expect, { "pathology": "stalled", "settleBudget": 300 });
	assert.deepEqual([replay.faithful, replay.focusFaults.has("stalled"), replay.focusReached], [true, true, false]);
});
