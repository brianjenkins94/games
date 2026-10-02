/**
 * Players in separate tabs (play.html, W3): one match across several tabs of one browser — the first hosts it, the
 * rest join through the lobby (Web Locks + BroadcastChannel) — each tab its own hub tree, observed on its own. Built
 * and served as it ships (see harness.ts). netsim's tests, with war2 inside.
 */
import type { Page } from "playwright";
import type { Session } from "./harness.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startSession, status, tool, until, untilInSync } from "./harness.ts";

interface Divergence { "tick": number; "clients": { "peer": string; "comparable": boolean; "identical"?: boolean; "reason"?: string }[] }
interface View { "team": number | undefined; "viewTick": number; "inSync": boolean }

let session: Session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close();
});

/** Open a tab at match `match`; resolves once it knows whether it's hosting or joined. */
async function openPlay(match: string, settings: Record<string, number> = {}): Promise<Page> {
	const page = await session.context.newPage();
	const query = new URLSearchParams({ "match": match, ...Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, String(value)])) });

	await page.goto(`${session.url}play.html?${query}`);
	await until(page, "a place in the match", () => (globalThis as unknown as { "__war2Play"?: unknown }).__war2Play !== undefined);

	return page;
}

async function place(page: Page): Promise<{ "match": string; "role": string; "peer": string }> {
	return page.evaluate(() => (globalThis as unknown as { "__war2Play": { "match": string; "role": string; "peer": string } }).__war2Play);
}

async function view(page: Page): Promise<View | undefined> {
	return page.evaluate(() => (globalThis as unknown as { "__war2": { "view": () => View | undefined } }).__war2.view());
}

async function pauseAndSettle(host: Page): Promise<Divergence> {
	await tool(host, "war2_control", { "action": "pause" });

	return until(host, "every client at the paused tick", async () => {
		const war2 = (globalThis as unknown as { "__war2": { "tool": (name: string) => Promise<Divergence> } }).__war2;
		const divergence = await war2.tool("war2_divergence");

		// (Another tab's player is that tab's to inspect: the host diffs its own.)
		return divergence.clients.every((client) => client.comparable || client.reason?.startsWith("in another tab")) ? divergence : undefined;
	});
}

test("players in separate tabs play one match: the first tab hosts, the rest join, and every client stays in sync", async () => {
	const host = await openPlay("sync", { "teams": 3 });
	const players = [await openPlay("sync"), await openPlay("sync")];

	assert.deepEqual(await place(host), { "match": "sync", "role": "host", "peer": "player-0" });
	assert.deepEqual(await Promise.all(players.map(place)), [{ "match": "sync", "role": "player", "peer": "player-1" }, { "match": "sync", "role": "player", "peer": "player-2" }]);
	await untilInSync(host, 3);

	// Bots play in every tab: nobody may ever be out of sync or see a gap.
	for (let sample = 0; sample < 10; sample += 1) {
		for (const client of (await status(host)).clients) {
			assert.notEqual(client.state, "OUT OF SYNC", JSON.stringify(client));
			assert.deepEqual([client.stats["desyncs"], client.stats["gaps"]], [0, 0], JSON.stringify(client));
		}

		await host.waitForTimeout(200);
	}

	// Each player's own tab draws its own team, in sync.
	const views = await Promise.all(players.map(async (page) => until(page, "its view", async () => {
		const latest = (globalThis as unknown as { "__war2": { "view": () => View | undefined } }).__war2.view();

		return latest?.team !== undefined && latest.inSync ? latest : undefined;
	})));
	const teams = new Set([(await status(host)).clients.find((client) => client.peer === "player-0")!.team, ...views.map((latest) => latest.team)]);

	assert.equal(teams.size, 3, "three players, three teams");

	// And the host can check its own player against authority, unit by unit; the other tabs' players are theirs to
	// inspect (their sync is checked here all the same: their view hashes, above).
	const divergence = await pauseAndSettle(host);

	assert.deepEqual(divergence.clients.map((client) => [client.peer, client.comparable ? client.identical : "elsewhere"]), [["player-0", true], ["player-1", "elsewhere"], ["player-2", "elsewhere"]]);

	for (const page of [host, ...players]) {
		await page.close();
	}
});

test("a player who reloads their tab keeps their id and seat, and plays on", async () => {
	const host = await openPlay("reload");
	const player = await openPlay("reload");

	await untilInSync(host, 2);

	const { team } = (await status(host)).clients.find((client) => client.peer === "player-1")!;

	await player.reload();
	await until(player, "a place in the match", () => (globalThis as unknown as { "__war2Play"?: unknown }).__war2Play !== undefined);
	assert.deepEqual(await place(player), { "match": "reload", "role": "player", "peer": "player-1" });
	await until(player, "back in sync", () => (globalThis as unknown as { "__war2": { "view": () => View | undefined } }).__war2.view()?.inSync === true);
	await untilInSync(host, 2);

	const seats = (await tool<{ "seats": { "peer": string; "team": number }[] }>(host, "war2_status")).seats;

	assert.deepEqual(seats.map((seat) => seat.peer).sort(), ["player-0", "player-1"], "no new seat was taken");
	assert.equal(seats.find((seat) => seat.peer === "player-1")!.team, team, "the same seat");
	await host.close();
	await player.close();
});

test("when a player's tab goes, its data channel closes and the referee lets it go", async () => {
	const host = await openPlay("gone");
	const player = await openPlay("gone");

	await untilInSync(host, 2);
	await player.close();

	const gone = await until(host, "the referee letting the player go", () => (globalThis as unknown as { "__war2": { "logs": (source: string) => { "message"?: string; "attrs"?: Record<string, unknown> }[] } }).__war2.logs("referee").find((record) => record.message === "client gone" && record.attrs?.["peer"] === "player-1")?.attrs, { "timeoutMs": 10_000 });

	assert.equal(gone["why"], "the transport closed", "its data channel closed — no need to wait out the heartbeat");
	await host.close();
});

test("when the host's tab goes, its players are told", async () => {
	const host = await openPlay("leave");
	const player = await openPlay("leave");

	await untilInSync(host, 2);
	await host.close();
	await until(player, "told the host left", () => document.querySelector("#summary")!.textContent!.includes("host left"));
	await player.close();
});
