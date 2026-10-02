/**
 * The incident corpus (W4): every fixture in test/incidents/ — a captured moment of a match, saved from the live game
 * (`war2_save_incident_test`) or from a scenario (`npm run record -- --incident <scenario>`) — replayed from its snapshot
 * through its commands (src/diag/replay.ts). Each must reach its captured world exactly (its hash at the flag tick:
 * the repro is faithful), then meet its expectation: its fault shows again (a known bug, pinned until it's fixed — then
 * flip the fixture to `reachesGoal`), or the focus unit reaches its goal (fixed, and staying fixed). Drop a fixture's
 * JSON to retire it.
 */
import type { Fixture } from "../src/diag/recorder.ts";
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";
import { loadGameMap } from "../src/browser/maps.ts";
import { replayFixture } from "../src/diag/replay.ts";

const DIR = path.resolve(import.meta.dirname, "incidents");
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((file) => file.endsWith(".json")).sort() : [];

test("the corpus has fixtures (the runner is exercised, not vacuously green)", () => {
	assert.ok(files.length > 0);
});

test("a fixture whose replay doesn't reach its captured world is caught: the hash check bites", () => {
	const fixture = JSON.parse(fs.readFileSync(path.join(DIR, files[0]))) as Fixture;
	const map = fixture.map as Exclude<Fixture["map"], string>;

	assert.equal(replayFixture(fixture, map).faithful, true);
	fixture.snapshot.rngState += 1;   // a world that's a hair different…
	assert.equal(replayFixture(fixture, map).faithful, false, "…isn't the captured one");
});

for (const file of files) {
	const fixture = JSON.parse(fs.readFileSync(path.join(DIR, file))) as Fixture;

	test(`incident ${fixture.id}: ${fixture.label}`, async () => {
		const map = typeof fixture.map === "string" ? (await loadGameMap(fixture.map)).info : fixture.map;
		const replay = replayFixture(fixture, map);

		assert.equal(replay.faithful, true, `the replay reached hash ${replay.hash}, not the captured ${fixture.expectHash}`);

		if (fixture.expect.pathology !== undefined) {
			assert.ok(replay.focusFaults.has(fixture.expect.pathology), `the focus unit's ${fixture.expect.pathology} shows again (saw: ${[...replay.focusFaults].join(", ") || "nothing"}) — fixed? flip the fixture to reachesGoal`);
		}

		if (fixture.expect.reachesGoal === true) {
			assert.equal(replay.focusReached, true, "the focus unit reaches its goal");
		}
	});
}
