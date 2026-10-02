/**
 * Players on other machines (W3b): `play.html?lobby=peerjs` finds the match through a PeerJS broker and links through
 * PeerJS's own peer connections. Two browser contexts stand in for two machines — they share no BroadcastChannel, no
 * Web Lock, no storage — so the only way they meet is the broker (our own here, in a child process; PeerJS's cloud by
 * default) and the only way they play is over PeerJS's data channel, straight between the workers.
 */
import type { BrowserContext, Page } from "playwright";
import type { Session } from "./harness.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startBroker } from "./broker.ts";
import { startSession, status, tool, until, untilInSync } from "./harness.ts";

interface View { "team": number | undefined; "viewTick": number; "inSync": boolean }

let session: Session;
let broker: Awaited<ReturnType<typeof startBroker>>;
const contexts: BrowserContext[] = [];

before(async () => {
	broker = await startBroker();
	session = await startSession();
});

after(async () => {
	for (const context of contexts) {
		await context.close();
	}

	await session?.close();
	broker?.stop();
});

/** A tab on a machine of its own (a fresh browser context), at match `match` through the broker. */
async function openOnline(match: string, extra: Record<string, string> = {}): Promise<Page> {
	const context = await session.browser.newContext();

	contexts.push(context);
	await context.routeWebSocket(/:7378/u, (route) => { void route.close(); });

	const page = await context.newPage();
	const query = new URLSearchParams({ "match": match, "lobby": "peerjs", "broker": `localhost:${broker.port}`, "ice": "none", ...extra });

	await page.goto(`${session.url}play.html?${query}`);
	await until(page, "a place in the match", () => (globalThis as unknown as { "__war2Play"?: unknown }).__war2Play !== undefined);

	return page;
}

async function place(page: Page): Promise<{ "match": string; "role": string; "peer": string }> {
	return page.evaluate(() => (globalThis as unknown as { "__war2Play": { "match": string; "role": string; "peer": string } }).__war2Play);
}

async function inSync(page: Page): Promise<View> {
	return until(page, "its view in sync", () => {
		const latest = (globalThis as unknown as { "__war2": { "view": () => View | undefined } }).__war2.view();

		return latest?.team !== undefined && latest.inSync ? latest : undefined;
	}, { "timeoutMs": 20_000 });
}

test("players on two machines play one match through PeerJS: the first registers the match and hosts, the other dials it", async () => {
	const match = `online-${Date.now()}`;
	const host = await openOnline(match);
	const player = await openOnline(match);
	const joined = await place(player);

	assert.deepEqual(await place(host), { "match": match, "role": "host", "peer": "player-0" });
	assert.equal(joined.role, "player");
	assert.match(joined.peer, /^player-[\w-]+$/u);
	await untilInSync(host, 2);

	// The host checks both clients against authority — its own and the other machine's (by view hash, every tick).
	for (let sample = 0; sample < 10; sample += 1) {
		for (const client of (await status(host)).clients) {
			assert.notEqual(client.state, "OUT OF SYNC", JSON.stringify(client));
			assert.deepEqual([client.stats["desyncs"], client.stats["gaps"]], [0, 0], JSON.stringify(client));
		}

		await host.waitForTimeout(200);
	}

	const view = await inSync(player);
	const hostTeam = (await status(host)).clients.find((client) => client.peer === "player-0")!.team;

	assert.notEqual(view.team, hostTeam, "two players, two teams");
	assert.deepEqual((await tool<{ "seats": { "peer": string }[] }>(host, "war2_status")).seats.map((seat) => seat.peer).sort(), [joined.peer, "player-0"].sort());
});

test("a player who reloads keeps their name and seat, and plays on", async () => {
	const match = `online-reload-${Date.now()}`;
	const host = await openOnline(match);
	const player = await openOnline(match);
	const { peer } = await place(player);

	await untilInSync(host, 2);

	const { team } = (await status(host)).clients.find((client) => client.peer === peer)!;

	await player.reload();
	await until(player, "a place in the match", () => (globalThis as unknown as { "__war2Play"?: unknown }).__war2Play !== undefined);
	assert.equal((await place(player)).peer, peer, "the same name");
	await inSync(player);
	await untilInSync(host, 2);

	const seats = (await tool<{ "seats": { "peer": string; "team": number }[] }>(host, "war2_status")).seats;

	assert.equal(seats.length, 2, "no new seat was taken");
	assert.equal(seats.find((seat) => seat.peer === peer)!.team, team, "the same seat");
});

test("when the host goes, the player on the other machine is told", async () => {
	const match = `online-leave-${Date.now()}`;
	const host = await openOnline(match);
	const player = await openOnline(match);

	await untilInSync(host, 2);
	await host.close();
	await until(player, "told the host left", () => document.querySelector("#summary")!.textContent!.includes("host left"), { "timeoutMs": 30_000 });
});
