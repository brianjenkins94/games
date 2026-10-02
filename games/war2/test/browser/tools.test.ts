/**
 * war2's diagnostic tools in the browser (W4): the referee's flight recorder through the host page's tools — and the
 * round trip from a live match to a regression test: an incident flagged in the browser, saved as a fixture, replays in
 * node to exactly the captured world.
 */
import type { Fixture } from "../../src/diag/recorder.ts";
import type { Session } from "./harness.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { loadGameMap } from "../../src/browser/maps.ts";
import { replayFixture } from "../../src/diag/replay.ts";
import { assertQuiet, startSession, tool, until } from "./harness.ts";

interface Unit { "uid": number; "team": number; "type": string; "x": number; "y": number; "building"?: unknown }
interface State { "tick": number; "units": Unit[]; "clients": { "peer": string; "team": number }[] }

let session: Session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close();
});

test("a move, flagged as an incident in the browser and saved as a fixture, replays in node to exactly the captured world", async () => {
	const page = await session.open({ "clients": 2, "bots": 0, "map": "arena" });
	const state = await tool<State>(page, "war2_state");
	const team = state.clients.find((client) => client.peer === "client-0")!.team;
	const unit = state.units.find((candidate) => candidate.team === team && candidate.building === undefined)!;

	// Some recent past for the recorder: a command after its first snapshot (tick 30 — before that, the command would be
	// in the snapshot, not after it), and a second or two of play.
	await until(page, "the recorder's first snapshot", async () => ((await (globalThis as unknown as { "__war2": { "tool": (name: string) => Promise<{ "tick": number }> } }).__war2.tool("war2_status")).tick > 35));
	assert.equal((await tool<{ "received": boolean }>(page, "war2_command", { "client": "client-0", "type": "move", "units": [unit.uid], "x": 16.5, "y": 2.5 })).received, true);
	await page.waitForTimeout(1500);

	const summary = await tool<{ "command": { "units": number[]; "target": [number, number] }; "units": { "uid": number; "start": [number, number] }[] }>(page, "war2_summarize_move");

	assert.deepEqual([summary.command.units, summary.command.target], [[unit.uid], [16, 2]]);

	const flagged = await tool<{ "id": string; "flagTick": number; "baseTick": number; "commands": number }>(page, "war2_flag_incident", { "label": "a test's move" });
	const saved = await tool<{ "path": string; "fixture": Fixture }>(page, "war2_save_incident_test", { "id": flagged.id });

	assert.match(saved.path, /^games\/war2\/test\/incidents\/arena-incident-t\d+\.json$/u);
	assert.equal(saved.fixture.map, "arena");
	assert.ok(saved.fixture.commands.some((entry) => entry.command.type === 1), "the move is in its commands");

	const replay = replayFixture(saved.fixture, (await loadGameMap("arena")).info);

	assert.equal(replay.faithful, true, `node replayed it to hash ${replay.hash}, the browser captured ${saved.fixture.expectHash}`);
	await assertQuiet(page);
	await page.close();
});

test("an incident replays live: the match rewinds to its lead-up, paused, and stepping brings it back to the flagged moment, exactly", async () => {
	const page = await session.open({ "clients": 2, "bots": 0, "map": "arena" });
	const state = await tool<State>(page, "war2_state");
	const team = state.clients.find((client) => client.peer === "client-0")!.team;
	const unit = state.units.find((candidate) => candidate.team === team && candidate.building === undefined)!;

	await tool(page, "war2_command", { "client": "client-0", "type": "move", "units": [unit.uid], "x": 16.5, "y": 2.5 });
	await page.waitForTimeout(1200);
	await tool(page, "war2_control", { "action": "pause" });

	const flagged = await tool<{ "id": string; "flagTick": number; "baseTick": number }>(page, "war2_flag_incident");
	const beforeState = await tool<State>(page, "war2_state");
	const beforeTick = beforeState.tick;
	const before = beforeState.units.find((candidate) => candidate.uid === unit.uid)!;
	const rewound = await tool<{ "tick": number; "paused": boolean; "flagTick": number }>(page, "war2_replay_incident", { "id": flagged.id });

	assert.deepEqual([rewound.tick, rewound.paused, rewound.flagTick], [flagged.baseTick, true, flagged.flagTick]);
	// (Flagged on a snapshot's own tick, there's nothing to step: the rewind is the moment.)
	const stepped = flagged.flagTick > flagged.baseTick ? await tool<{ "tick": number }>(page, "war2_control", { "action": "step", "ticks": flagged.flagTick - flagged.baseTick }) : rewound;
	const after = await tool<State>(page, "war2_state");
	const again = after.units.find((candidate) => candidate.uid === unit.uid)!;

	assert.deepEqual([stepped.tick, after.tick, again.x, again.y], [flagged.flagTick, flagged.flagTick, before.x, before.y], `where it was when flagged (flagged ${JSON.stringify(flagged)}, read before at tick ${beforeTick})`);

	// And every client catches up with the rewound match.
	await until(page, "every client in sync again", () => (globalThis as unknown as { "__war2": { "status": () => { "clients": { "state": string }[] } } }).__war2.status().clients.every((client) => client.state === "in sync"));
	await page.close();
});

test("the pathology tools answer: what's wrong now, a unit with its track, a region's clearances", async () => {
	const page = await session.open({ "clients": 2, "bots": 0, "map": "arena" });
	const state = await tool<State>(page, "war2_state");
	const unit = state.units.find((candidate) => candidate.building === undefined)!;
	const tile = [Math.floor(unit.x / 32_000), Math.floor(unit.y / 32_000)];
	const faults = await tool<{ "units": unknown[] }>(page, "war2_pathologies");
	const one = await tool<{ "uid": number; "tile": number[]; "track": { "tile": number[] }[] }>(page, "war2_unit", { "uid": unit.uid });
	const region = await tool<{ "units": { "uid": number }[]; "clearances": { "pair": number[]; "clearancePx": number }[] }>(page, "war2_region", { "tx": tile[0], "ty": tile[1], "r": 6 });

	assert.deepEqual(faults.units, [], "nobody's in trouble at rest");
	assert.deepEqual([one.uid, one.tile], [unit.uid, tile]);
	assert.deepEqual(one.track.at(-1)?.tile, tile);
	assert.ok(region.units.some((candidate) => candidate.uid === unit.uid));
	assert.ok(region.clearances.every((pair, index, all) => index === 0 || all[index - 1]!.clearancePx <= pair.clearancePx), "tightest first");
	await page.close();
});
