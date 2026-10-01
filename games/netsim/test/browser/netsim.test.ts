/**
 * netsim in a real browser: the page, the referee worker, N instance iframes and their client workers, linked by
 * MessageChannels, observed end to end. Built and served as it ships (see harness.ts).
 */
import type { Page } from "playwright";
import type { Session } from "./harness.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FP } from "../../src/sim/index.ts";
import { status, startSession, tool, until } from "./harness.ts";

interface Unit { "id": number; "team": number; "x": number; "y": number; "tx": number; "ty": number; "moving": number }
interface State { "tick": number; "paused": boolean; "units": Unit[]; "clients": { "peer": string; "team": number; "viewTick": number; "units": Unit[]; "predicted": Unit[] }[] }
interface Divergence { "tick": number; "clients": { "peer": string; "comparable": boolean; "identical"?: boolean; "reason"?: string }[] }

let session: Session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close();
});

/** Pause the referee and wait for every client to reach its tick (a paused referee's last update still lands). */
async function pauseAndSettle(page: Page): Promise<Divergence> {
	await tool(page, "netsim_control", { "action": "pause" });

	for (let attempt = 0; attempt < 50; attempt += 1) {
		const divergence = await tool<Divergence>(page, "netsim_divergence");

		if (divergence.clients.every((client) => client.comparable)) {
			return divergence;
		}

		await page.waitForTimeout(50);
	}

	throw new Error("clients never caught up with the paused referee");
}

test("three instances, three workers, one referee: every client stays in sync with authority", async () => {
	const page = await session.open({ "clients": 3 });

	// Bots are playing: sample the status table for a few seconds; nobody may ever be out of sync or see a gap.
	for (let sample = 0; sample < 15; sample += 1) {
		const { clients } = await status(page);

		assert.equal(clients.length, 3);

		for (const client of clients) {
			assert.notEqual(client.state, "OUT OF SYNC", JSON.stringify(client));
			assert.equal(client.stats["desyncs"], 0, JSON.stringify(client));
			assert.equal(client.stats["gaps"], 0, JSON.stringify(client));
		}

		await page.waitForTimeout(200);
	}

	// And exactly: at a paused tick, each client's view is what the referee says its team can see, unit for unit.
	const divergence = await pauseAndSettle(page);

	assert.deepEqual(divergence.clients.map((client) => [client.peer, client.identical]), [["client-0", true], ["client-1", true], ["client-2", true]]);

	const { stats } = await tool<{ "stats": Record<string, number> }>(page, "netsim_status");

	assert.ok(stats["commandsApplied"] > 0, "the bots were really playing");
	assert.equal(stats["commandsRejected"], 0);
	assert.equal(stats["unknownSender"], 0);
	await page.close();
});

test("every context reports to the page: logs, and its place in the hub tree", async () => {
	const page = await session.open({ "clients": 2 });
	const expected = ["page", "referee", "client-0", "client-1", "client-0/ui", "client-1/ui"];

	// Every hub, and the tree's links between them (each reported as its hubs report — wait for them all).
	await until(page, "every hub and link in the architecture", (ids: string[]) => {
		const { nodes, channels } = (globalThis as unknown as { "__netsim": { "architecture": () => { "nodes": { "id": string }[]; "channels": { "a": string; "b": string }[] } } }).__netsim.architecture();
		const joined = (a: string, b: string) => channels.some((channel) => (channel.a === a && channel.b === b) || (channel.a === b && channel.b === a));

		return ids.every((id) => nodes.some((node) => node.id === id)) && joined("page", "referee") && ["client-0", "client-1"].every((client) => joined("referee", client) && joined(client, client + "/ui"));
	}, { "arg": expected });

	const snapshot = await page.evaluate(() => (globalThis as unknown as { "__netsim": { "architecture": () => { "channels": { "a": string; "b": string }[] } } }).__netsim.architecture());
	const linked = (a: string, b: string) => snapshot.channels.some((channel) => (channel.a === a && channel.b === b) || (channel.a === b && channel.b === a));

	// Every context under the id it's known by — no client worker under the placeholder its hub starts as.
	assert.ok(!snapshot.channels.some((channel) => channel.a === "client" || channel.b === "client"), JSON.stringify(snapshot.channels.map((channel) => channel.a + " ─ " + channel.b)));

	// The tree: page ─ referee ─ client-i ─ client-i.ui.
	assert.ok(linked("page", "referee"), JSON.stringify(snapshot.channels));
	assert.ok(linked("referee", "client-0") && linked("referee", "client-1"), JSON.stringify(snapshot.channels));
	assert.ok(linked("client-0", "client-0/ui") && linked("client-1", "client-1/ui"), JSON.stringify(snapshot.channels));

	const sources = await page.evaluate(() => [...new Set((globalThis as unknown as { "__netsim": { "logs": () => { "context"?: { "source"?: string } }[] } }).__netsim.logs().map((record) => record.context?.source))]);

	for (const source of ["page", "referee", "client-0", "client-1"]) {
		assert.ok(sources.includes(source), `logs from ${source}: ${JSON.stringify(sources)}`);
	}

	await page.close();
});

test("the messages past the hub are seen too: the page's to its workers and frames, each frame's to its worker", async () => {
	const page = await session.open({ "clients": 2 });
	// Each channel, and a raw message that must have crossed it (a worker's start-up, a frame's channel to the referee).
	const expected: [string, string, string][] = [["page", "referee", "netsim-init"], ["page", "referee", "netsim-attach"], ["page", "client-0/ui", "netsim-port"], ["client-0/ui", "client-0", "netsim-port"]];

	await until(page, "every raw message in the architecture", (wanted: [string, string, string][]) => {
		const channels = (globalThis as unknown as { "__netsim": { "architecture": () => { "channels": { "a": string; "b": string; "labels": Record<string, unknown> }[] } } }).__netsim.architecture().channels;

		return wanted.every(([a, b, label]) => channels.some((channel) => ((channel.a === a && channel.b === b) || (channel.a === b && channel.b === a)) && label in channel.labels));
	}, { "arg": expected });
	await page.close();
});

test("an uncaught error in a client's worker is reported to the page, attributed to that client", async () => {
	const page = await session.open({ "clients": 2 });
	const workers = page.workers().filter((worker) => worker.url().includes("client.worker"));

	assert.equal(workers.length, 2);

	// Which worker is client-1's? Each names its hub after its client; ask them all to throw, tagged.
	for (const [index, worker] of workers.entries()) {
		await worker.evaluate((tag) => { setTimeout(() => { throw new Error("boom " + tag); }); }, String(index));
	}

	/** Every "boom" error logged, once there are at least `min`. */
	const booms = (min: number) => {
		const records = (globalThis as unknown as { "__netsim": { "logs": () => { "level"?: string; "message"?: string; "attrs"?: { "stack"?: string }; "context"?: { "source"?: string } }[] } }).__netsim.logs();

		const found = records.filter((record) => record.message?.includes("boom ")).map((record) => ({ "source": record.context?.source, "level": record.level, "message": record.message, "stack": record.attrs?.stack !== undefined }));

		return found.length >= min ? found : undefined;
	};

	await until(page, "both errors reported", booms, { "arg": 2 });
	// Give a duplicate (the owning instance page re-raising it) time to show up.
	await page.waitForTimeout(300);

	const errors = await page.evaluate(booms, 0);

	assert.equal(errors.length, 2, "each reported once: " + JSON.stringify(errors));
	assert.deepEqual(errors.map((error) => error.source).sort(), ["client-0", "client-1"]);
	assert.ok(errors.every((error) => error.level === "error" && error.stack), JSON.stringify(errors));
	await page.close();
});

test("pause and step are exact: N steps are N ticks, and every client follows each one", async () => {
	const page = await session.open({ "clients": 2 });
	const paused = await pauseAndSettle(page);
	const stepped = await tool<{ "tick": number; "paused": boolean }>(page, "netsim_control", { "action": "step", "ticks": 7 });

	assert.deepEqual(stepped, { "tick": paused.tick + 7, "paused": true });

	const after = await pauseAndSettle(page);

	assert.equal(after.tick, paused.tick + 7, "nothing ticked but the steps");
	assert.ok(after.clients.every((client) => client.identical), JSON.stringify(after));

	// Paused means paused: a while later, still the same tick — and the clients, still reporting, aren't "stalled".
	await page.waitForTimeout(1500);

	const idle = await tool<{ "tick": number; "clients": { "state": string }[] }>(page, "netsim_status");

	assert.equal(idle.tick, after.tick);
	assert.deepEqual(idle.clients.map((client) => client.state), ["in sync", "in sync"]);

	await tool(page, "netsim_control", { "action": "resume" });
	await until(page, "ticking again", (from: number) => {
		const tick = (globalThis as unknown as { "__netsim": { "status": () => { "tick"?: number } } }).__netsim.status().tick;

		return tick !== undefined && tick > from + 5;
	}, { "arg": after.tick });
	await page.close();
});

test("a client that stops reporting shows as stalled, not as whatever it last said", async () => {
	const page = await session.open({ "clients": 2 });
	const workers = page.workers().filter((worker) => worker.url().includes("client.worker"));
	const names = await Promise.all(workers.map(async (worker) => worker.evaluate(() => (globalThis as unknown as { "name": string }).name)));
	const dying = workers[names.indexOf("client-1")];

	// Its worker dies (as if it crashed): no more reports, though its last one said "in sync".
	await dying.evaluate(() => { globalThis.close(); });

	const stalled = await until(page, "client-1 stalled", () => {
		const { clients } = (globalThis as unknown as { "__netsim": { "status": () => { "clients": { "peer": string; "state": string }[] } } }).__netsim.status();

		return clients.find((client) => client.peer === "client-1")?.state === "stalled" ? clients : undefined;
	});

	assert.deepEqual(stalled.map((client) => [client.peer, client.state]), [["client-0", "in sync"], ["client-1", "stalled"]]);
	assert.equal(await page.locator("#status tr[data-state=\"stalled\"] td").first().textContent(), "client-1", "and the table shows it");
	await page.close();
});

test("a player's clicks move a unit, end to end: canvas → instance → client worker → referee → every view", async () => {
	const page = await session.open({ "clients": 2, "bots": 0 });

	await pauseAndSettle(page);

	const state = await tool<State>(page, "netsim_state", { "client": "client-0" });
	const [client] = state.clients;
	const unit = client.units.find((candidate) => candidate.team === client.team)!;
	const frame = page.locator("iframe[title=\"client-0\"]");
	const box = (await frame.boundingBox())!;
	const width = 24 * FP;
	const toScreen = (x: number, y: number) => ({ "x": box.x + (x / width) * box.width, "y": box.y + (y / width) * box.height });
	// Target the middle of tile (4, 20).
	const target = { "x": 4.5 * FP, "y": 20.5 * FP };
	const before = await tool<{ "stats": Record<string, number>; "seats": { "peer": string; "lastSeq": number }[] }>(page, "netsim_status");
	const applied = before.stats["commandsApplied"];
	const seq = before.seats.find((seat) => seat.peer === "client-0")!.lastSeq;

	await page.mouse.click(toScreen(unit.x, unit.y).x, toScreen(unit.x, unit.y).y);
	await until(page, "the unit selected", (id: number) => {
		const instance = document.querySelector<HTMLIFrameElement>("iframe[title=\"client-0\"]")!.contentWindow as unknown as { "__netsimInstance": { "latest": () => { "selected"?: number } | undefined } };

		return instance.__netsimInstance.latest()?.selected === id;
	}, { "arg": unit.id });
	await page.mouse.click(toScreen(target.x, target.y).x, toScreen(target.x, target.y).y, { "button": "right" });

	// Predicted at once (the referee is still paused)…
	const predicted = await until(page, "the move predicted", async (id: number) => {
		const netsim = (globalThis as unknown as { "__netsim": { "tool": (name: string, args: unknown) => Promise<State> } }).__netsim;
		const mine = (await netsim.tool("netsim_state", { "client": "client-0" })).clients[0].predicted.find((candidate) => candidate.id === id);

		return mine !== undefined && mine.moving === 1 && mine.tx !== undefined && Math.abs(mine.tx - 4.5 * 1000) < 200 ? mine : undefined;
	}, { "arg": unit.id });

	// …then authoritative once the referee has the batch and ticks, and the same in the client's view.
	await until(page, "the referee to receive the move", async (from: number) => {
		const netsim = (globalThis as unknown as { "__netsim": { "tool": (name: string) => Promise<{ "seats": { "peer": string; "lastSeq": number }[] }> } }).__netsim;

		return (await netsim.tool("netsim_status")).seats.find((seat) => seat.peer === "client-0")!.lastSeq > from;
	}, { "arg": seq });
	await tool(page, "netsim_control", { "action": "step", "ticks": 3 });

	const settled = await pauseAndSettle(page);
	const after = await tool<State>(page, "netsim_state", { "client": "client-0" });
	const authority = after.units.find((candidate) => candidate.id === unit.id)!;

	assert.equal(authority.tx, predicted.tx);
	assert.equal(authority.ty, predicted.ty);
	// One pixel is 24 tiles / the frame's width; the click lands within a couple of them.
	assert.ok(Math.abs(authority.tx - target.x) < (width / box.width) * 2 && Math.abs(authority.ty - target.y) < (width / box.height) * 2, JSON.stringify({ authority, target }));
	assert.equal((await tool<{ "stats": Record<string, number> }>(page, "netsim_status")).stats["commandsApplied"], applied + 1);
	assert.ok(settled.clients.every((entry) => entry.identical), JSON.stringify(settled));
	await page.close();
});

test("netsim_command acts as a client, and the client's own check refuses another team's unit", async () => {
	const page = await session.open({ "clients": 2, "bots": 0 });

	await pauseAndSettle(page);

	const state = await tool<State>(page, "netsim_state");
	const ownerOf = (peer: string) => state.clients.find((client) => client.peer === peer)!.team;
	const mine = state.units.find((unit) => unit.team === ownerOf("client-1"))!;
	const theirs = state.units.find((unit) => unit.team === ownerOf("client-0"))!;

	// Refused by the client's own check (it can't even see that unit as its own), and by the referee.
	assert.deepEqual(await tool(page, "netsim_command", { "client": "client-1", "type": "move", "units": [theirs.id], "x": 1, "y": 1 }), { "ok": false, "reason": "unknown-unit", "viewTick": state.tick, "received": true });

	const accepted = await tool<{ "ok": boolean; "received": boolean }>(page, "netsim_command", { "client": "client-1", "type": "move", "units": [mine.id], "x": 2, "y": 3 });

	assert.deepEqual([accepted.ok, accepted.received], [true, true]);
	await tool(page, "netsim_control", { "action": "step", "ticks": 3 });

	const after = await tool<State>(page, "netsim_state");

	assert.deepEqual([after.units.find((unit) => unit.id === mine.id)!.tx, after.units.find((unit) => unit.id === mine.id)!.ty], [2 * FP, 3 * FP]);
	assert.equal(after.units.find((unit) => unit.id === theirs.id)!.tx, theirs.tx, "the other team's unit is untouched");
	assert.equal((await tool<{ "stats": Record<string, number> }>(page, "netsim_status")).stats["commandsRejected"], 1);
	await page.close();
});

test("a player who reloads their instance mid-match rejoins their seat, catches up, and plays on", async () => {
	const page = await session.open({ "clients": 2, "bots": 0 });
	const before = await tool<{ "seats": { "team": number; "peer": string }[] }>(page, "netsim_status");
	const team = before.seats.find((seat) => seat.peer === "client-1")!.team;
	const mine = (await tool<State>(page, "netsim_state")).units.find((candidate) => candidate.team === team)!;

	// It has played before the reload (so its seat's command sequence isn't at the start).
	assert.equal((await tool<{ "received": boolean }>(page, "netsim_command", { "client": "client-1", "type": "move", "units": [mine.id], "x": 2, "y": 2 })).received, true);
	await page.evaluate(() => { document.querySelector<HTMLIFrameElement>("iframe[title=\"client-1\"]")!.contentWindow!.location.reload(); });
	await until(page, "client-1 rejoined", () => (globalThis as unknown as { "__netsim": { "logs": () => { "message"?: string; "context"?: { "source"?: string } }[] } }).__netsim.logs().some((record) => record.context?.source === "client-1" && record.message === "rejoined"));

	// Caught up with authority: pause, and its view is exactly what the referee says its team sees.
	await tool(page, "netsim_control", { "action": "pause" });

	const divergence = await until(page, "client-1 at the paused tick", async () => {
		const netsim = (globalThis as unknown as { "__netsim": { "tool": (name: string, args: unknown) => Promise<Divergence> } }).__netsim;
		const answer = await netsim.tool("netsim_divergence", { "client": "client-1" });

		return answer.clients[0].comparable ? answer : undefined;
	});

	assert.equal(divergence.clients[0].identical, true, JSON.stringify(divergence));

	const after = await tool<{ "seats": { "team": number; "peer": string }[]; "stats": Record<string, number> }>(page, "netsim_status");

	assert.equal(after.seats.length, 2, "no new seat was taken");
	assert.equal(after.seats.find((seat) => seat.peer === "client-1")!.team, team, "the same seat");

	// And it plays on: its commands follow on from the seat's sequence, so the referee takes them.
	const state = await tool<State>(page, "netsim_state");
	const unit = state.units.find((candidate) => candidate.team === team)!;
	const played = await tool<{ "ok": boolean; "received": boolean }>(page, "netsim_command", { "client": "client-1", "type": "move", "units": [unit.id], "x": 5, "y": 6 });

	assert.deepEqual([played.ok, played.received], [true, true]);
	await tool(page, "netsim_control", { "action": "step", "ticks": 2 });

	const moved = (await tool<State>(page, "netsim_state")).units.find((candidate) => candidate.id === unit.id)!;

	assert.deepEqual([moved.tx, moved.ty], [5 * FP, 6 * FP]);

	const logs = await page.evaluate(() => (globalThis as unknown as { "__netsim": { "logs": () => { "message"?: string; "context"?: { "source"?: string } }[] } }).__netsim.logs().map((record) => `${record.context?.source} ${record.message}`));

	assert.ok(logs.includes("referee client relinked"), "the referee replaced the dead link");
	await page.close();
});
