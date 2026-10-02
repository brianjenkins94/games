/**
 * war2 in a real browser (W3): the host page, the referee worker, an instance iframe and client worker per player,
 * every client linked to the referee over WebRTC, observed end to end. Built and served as it ships (harness.ts).
 * netsim's browser tests, with war2 inside.
 */
import type { Page } from "playwright";
import type { Session } from "./harness.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startSession, tool, until } from "./harness.ts";

const TILE = 32_000;

interface Unit { "uid": number; "team": number; "type": string; "x": number; "y": number; "moving": boolean; "target"?: [number, number] }
interface State { "tick": number; "paused": boolean; "units": Unit[]; "clients": { "peer": string; "team": number; "viewTick": number; "view": Unit[]; "predicted": Unit[] }[] }
interface Divergence { "tick": number; "clients": { "peer": string; "comparable": boolean; "identical"?: boolean; "reason"?: string }[] }
interface Status { "tick": number; "paused": boolean; "speed": number; "stats": Record<string, number>; "seats": { "team": number; "peer": string; "lastSeq": number }[]; "clients": { "state": string }[] }

let session: Session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close();
});

/** Pause the referee and wait for every client to reach its tick (a paused referee's last update still lands). */
async function pauseAndSettle(page: Page): Promise<Divergence> {
	await tool(page, "war2_control", { "action": "pause" });

	for (let attempt = 0; attempt < 50; attempt += 1) {
		const divergence = await tool<Divergence>(page, "war2_divergence");

		if (divergence.clients.every((client) => client.comparable)) {
			return divergence;
		}

		await page.waitForTimeout(50);
	}

	throw new Error("clients never caught up with the paused referee");
}

test("two instances, two workers, one referee: every client stays in sync, and paused, every view is exactly authority's", async () => {
	const page = await session.open({ "clients": 2, "map": "arena" });

	await page.waitForTimeout(1500);

	const settled = await pauseAndSettle(page);

	assert.ok(settled.clients.every((client) => client.identical), JSON.stringify(settled));

	const status = await tool<Status>(page, "war2_status");

	assert.ok(status.stats["commandsApplied"] > 0, "the bots played");
	assert.equal(status.stats["commandsRejected"], 0);
	await page.close();
});

test("pause and step are exact: N steps are N ticks, and every client follows each one", async () => {
	const page = await session.open({ "clients": 2, "map": "arena" });
	const paused = await pauseAndSettle(page);
	const stepped = await tool<{ "tick": number; "paused": boolean }>(page, "war2_control", { "action": "step", "ticks": 7 });

	assert.deepEqual([stepped.tick, stepped.paused], [paused.tick + 7, true]);

	const after = await pauseAndSettle(page);

	assert.equal(after.tick, paused.tick + 7, "nothing ticked but the steps");
	assert.ok(after.clients.every((client) => client.identical), JSON.stringify(after));

	await page.waitForTimeout(1000);
	assert.equal((await tool<Status>(page, "war2_status")).tick, after.tick, "paused means paused");
	await page.close();
});

test("speed is the host's: the referee ticks faster at 4×, and its clients keep up", async () => {
	const page = await session.open({ "clients": 2, "bots": 0, "map": "arena" });
	const rate = async (): Promise<number> => {
		const from = (await tool<Status>(page, "war2_status")).tick;

		await page.waitForTimeout(1000);

		return (await tool<Status>(page, "war2_status")).tick - from;
	};
	const normal = await rate();

	assert.deepEqual(await tool(page, "war2_control", { "action": "speed", "speed": 4 }), { "tick": (await tool<Status>(page, "war2_status")).tick, "paused": false, "speed": 4 });

	const fast = await rate();

	assert.ok(fast > normal * 2.5, `${normal} ticks/s at 1×, ${fast} at 4×`);
	await pauseAndSettle(page);
	await page.close();
});

test("a player's clicks move a unit, end to end: renderer → instance → client worker → referee → every view", async () => {
	const page = await session.open({ "clients": 2, "bots": 0, "map": "arena" });

	await pauseAndSettle(page);

	const state = await tool<State>(page, "war2_state", { "client": "client-0" });
	const [client] = state.clients;
	const unit = client.view.find((candidate) => candidate.team === client.team)!;
	const frame = page.frameLocator("iframe[title=\"client-0\"]");
	const box = (await page.locator("iframe[title=\"client-0\"]").boundingBox())!;
	const instance = page.frames().find((candidate) => candidate.url().includes("id=client-0"))!;
	// A tile two away from the unit, on open ground (the arena's walls are columns 10 and 21, and part of row 8).
	const [tx, ty] = [Math.floor(unit.x / TILE), Math.floor(unit.y / TILE)];
	const open = (x: number, y: number) => x >= 0 && x < 32 && y >= 0 && y < 32 && !(x === 10 && y > 4 && y < 27 && y !== 15) && !(x === 21 && y > 4 && y < 27 && y !== 16) && !(y === 8 && x > 13 && x < 18);
	const [gx, gy] = [[2, -2], [2, 0], [0, -2], [-2, -2], [2, 2], [-2, 0]].map(([dx, dy]) => [tx + dx, ty + dy]).find(([x, y]) => open(x, y) && open(Math.round((x + tx) / 2), Math.round((y + ty) / 2)))!;
	const target = { "x": (gx + 0.5) * TILE, "y": (gy + 0.5) * TILE };
	const onScreen = async (x: number, y: number) => {
		const at = await instance.evaluate(([px, py]) => (globalThis as unknown as { "__war2Instance": { "toScreen": (x: number, y: number) => { "x": number; "y": number } } }).__war2Instance.toScreen(px, py), [x, y] as const);

		return { "x": box.x + at.x, "y": box.y + at.y };
	};
	const seq = (await tool<Status>(page, "war2_status")).seats.find((seat) => seat.peer === "client-0")!.lastSeq;

	await frame.locator("canvas").waitFor();
	await until(instance as unknown as Page, "the renderer ready", () => (globalThis as unknown as { "__war2Instance": { "ready": () => boolean } }).__war2Instance.ready());

	// Look at the unit (the minimap covers the panel's bottom-left), and keep the clicks clear of the minimap.
	await instance.evaluate(([x, y]) => { (globalThis as unknown as { "__war2Instance": { "lookAt": (x: number, y: number) => void } }).__war2Instance.lookAt(x, y); }, [unit.x, unit.y] as const);
	await page.waitForTimeout(100);

	const unitAt = await onScreen(unit.x, unit.y);

	await page.mouse.click(unitAt.x, unitAt.y);
	await until(page, "the unit selected", (uid: number) => {
		const latest = (document.querySelector<HTMLIFrameElement>("iframe[title=\"client-0\"]")!.contentWindow as unknown as { "__war2Instance": { "latest": () => { "selected": number[] } | undefined } }).__war2Instance.latest();

		return latest?.selected.includes(uid);
	}, { "arg": unit.uid });

	const targetAt = await onScreen(target.x, target.y);

	await page.mouse.click(targetAt.x, targetAt.y, { "button": "right" });

	// Predicted at once (the referee is still paused)…
	const predicted = await until(page, "the move predicted", async (uid: number) => {
		const war2 = (globalThis as unknown as { "__war2": { "tool": (name: string, args: unknown) => Promise<State> } }).__war2;
		const mine = (await war2.tool("war2_state", { "client": "client-0" })).clients[0].predicted.find((candidate) => candidate.uid === uid);

		return mine?.target === undefined ? undefined : mine;
	}, { "arg": unit.uid });

	// …then authoritative once the referee has the batch and ticks, and the same in the client's view.
	await until(page, "the referee to receive the move", async (from: number) => {
		const war2 = (globalThis as unknown as { "__war2": { "tool": (name: string) => Promise<Status> } }).__war2;

		return (await war2.tool("war2_status")).seats.find((seat) => seat.peer === "client-0")!.lastSeq > from;
	}, { "arg": seq });
	await tool(page, "war2_control", { "action": "step", "ticks": 3 });

	const settled = await pauseAndSettle(page);
	const authority = (await tool<State>(page, "war2_state")).units.find((candidate) => candidate.uid === unit.uid)!;

	assert.deepEqual(authority.target, predicted.target, "authority took the move the client predicted");
	// The sim rests units on its 8px grid: the target is within a cell of the click.
	assert.ok(Math.abs(authority.target![0] - target.x) <= 8000 && Math.abs(authority.target![1] - target.y) <= 8000, JSON.stringify({ authority, target }));
	assert.ok(settled.clients.every((entry) => entry.identical), JSON.stringify(settled));
	await page.close();
});

test("the renderer draws the game's own map: its terrain from the assets mirror, and every unit with its sprite", async () => {
	const page = await session.open({ "clients": 2, "bots": 0, "perTeam": 4 });
	const instance = page.frames().find((candidate) => candidate.url().includes("id=client-0"))!;
	const drawn = await until(instance as unknown as Page, "the units drawn", () => {
		const war2 = (globalThis as unknown as { "__war2Instance": { "drawn": () => { "units": number; "tileset": boolean } | undefined } }).__war2Instance;
		const now = war2.drawn();

		return now !== undefined && now.tileset && now.units >= 4 ? now : undefined;
	}, { "timeoutMs": 20_000 });

	assert.equal(drawn.tileset, true, "Plains of snow's tileset");
	assert.ok(drawn.units >= 4, `${drawn.units} unit sprites`);
	assert.equal((await instance.evaluate(() => (globalThis as unknown as { "__war2Instance": { "latest": () => { "map": string } } }).__war2Instance.latest().map)), "ladder/Plains of snow BNE");
	await page.close();
});

test("war2_command acts as a client, and the client's own check refuses another team's unit", async () => {
	const page = await session.open({ "clients": 2, "bots": 0, "map": "arena" });

	await pauseAndSettle(page);

	const state = await tool<State>(page, "war2_state");
	const ownerOf = (peer: string) => state.clients.find((client) => client.peer === peer)!.team;
	const mine = state.units.find((unit) => unit.team === ownerOf("client-1"))!;
	const theirs = state.units.find((unit) => unit.team === ownerOf("client-0"))!;
	const refused = await tool<{ "ok": boolean; "reason": string; "received": boolean }>(page, "war2_command", { "client": "client-1", "type": "move", "units": [theirs.uid], "x": 1.5, "y": 1.5 });

	// Unknown if it can't see the unit, not its own if it can: either way, never sent.
	assert.equal(refused.ok, false);
	assert.ok(["unknown-unit", "not-owner"].includes(refused.reason), refused.reason);
	assert.equal(refused.received, false);

	const accepted = await tool<{ "ok": boolean; "received": boolean }>(page, "war2_command", { "client": "client-1", "type": "move", "units": [mine.uid], "x": 16.5, "y": 2.5 });

	assert.deepEqual([accepted.ok, accepted.received], [true, true]);
	await tool(page, "war2_control", { "action": "step", "ticks": 3 });

	const after = await tool<State>(page, "war2_state");

	assert.deepEqual(after.units.find((unit) => unit.uid === mine.uid)!.target, [16.5 * TILE, 2.5 * TILE]);
	assert.deepEqual(after.units.find((unit) => unit.uid === theirs.uid)!.target, theirs.target, "the other team's unit is untouched");
	assert.equal((await tool<Status>(page, "war2_status")).stats["commandsRejected"], 0, "the refused one never reached the referee");
	await page.close();
});

test("a player who reloads their instance mid-match rejoins their seat, catches up, and plays on", async () => {
	const page = await session.open({ "clients": 2, "bots": 0, "map": "arena" });
	const before = await tool<Status>(page, "war2_status");
	const team = before.seats.find((seat) => seat.peer === "client-1")!.team;
	const mine = (await tool<State>(page, "war2_state")).units.find((candidate) => candidate.team === team)!;

	// It has played before the reload (so its seat's command sequence isn't at the start).
	assert.equal((await tool<{ "received": boolean }>(page, "war2_command", { "client": "client-1", "type": "move", "units": [mine.uid], "x": 16.5, "y": 2.5 })).received, true);
	await page.evaluate(() => { document.querySelector<HTMLIFrameElement>("iframe[title=\"client-1\"]")!.contentWindow!.location.reload(); });
	await until(page, "client-1 rejoined", () => (globalThis as unknown as { "__war2": { "logs": () => { "message"?: string; "context"?: { "source"?: string } }[] } }).__war2.logs().some((record) => record.context?.source === "client-1" && record.message === "rejoined"));

	const divergence = await pauseAndSettle(page);

	assert.ok(divergence.clients.every((client) => client.identical), JSON.stringify(divergence));

	const after = await tool<Status>(page, "war2_status");

	assert.equal(after.seats.length, 2, "no new seat was taken");
	assert.equal(after.seats.find((seat) => seat.peer === "client-1")!.team, team, "the same seat");

	const moved = await tool<{ "ok": boolean; "received": boolean }>(page, "war2_command", { "client": "client-1", "type": "move", "units": [mine.uid], "x": 18.5, "y": 2.5 });

	assert.deepEqual([moved.ok, moved.received], [true, true], "and plays on");
	await page.close();
});
