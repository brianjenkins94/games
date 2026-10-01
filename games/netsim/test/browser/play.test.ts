/**
 * Players in separate tabs (play.html): one match across several tabs of one browser — the first hosts it, the rest
 * join through the lobby (Web Locks + BroadcastChannel) — each tab its own hub tree, observed on its own. Built and served as it
 * ships (see harness.ts).
 */
import type { Page } from "playwright";
import type { Session } from "./harness.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FP } from "../../src/sim/index.ts";
import { startSession, status, tool, until, untilInSync } from "./harness.ts";

interface Unit { "id": number; "team": number; "x": number; "y": number; "tx": number; "ty": number }
interface Divergence { "tick": number; "clients": { "peer": string; "comparable": boolean; "identical"?: boolean; "reason"?: string }[] }
interface View { "team": number | undefined; "viewTick": number; "inSync": boolean; "units": number[][] }
interface LogEntry { "message"?: string; "context"?: { "source"?: string } }

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
	await until(page, "a place in the match", () => (globalThis as unknown as { "__netsimPlay"?: unknown }).__netsimPlay !== undefined);

	return page;
}

async function place(page: Page): Promise<{ "match": string; "role": string; "peer": string }> {
	return page.evaluate(() => (globalThis as unknown as { "__netsimPlay": { "match": string; "role": string; "peer": string } }).__netsimPlay);
}

async function view(page: Page): Promise<View | undefined> {
	return page.evaluate(() => (globalThis as unknown as { "__netsim": { "view": () => View | undefined } }).__netsim.view());
}

async function sources(page: Page): Promise<Set<string>> {
	return new Set(await page.evaluate(() => (globalThis as unknown as { "__netsim": { "logs": () => LogEntry[] } }).__netsim.logs().map((record) => record.context?.source ?? "")));
}

async function pauseAndSettle(host: Page): Promise<Divergence> {
	await tool(host, "netsim_control", { "action": "pause" });

	return until(host, "every client at the paused tick", async () => {
		const netsim = (globalThis as unknown as { "__netsim": { "tool": (name: string) => Promise<Divergence> } }).__netsim;
		const divergence = await netsim.tool("netsim_divergence");

		// (Another tab's player is that tab's to inspect: the host diffs its own.)
		return divergence.clients.every((client) => client.comparable || client.reason?.startsWith("in another tab")) ? divergence : undefined;
	});
}

test("players in separate tabs play one match: the first tab hosts, the rest join, and every client stays in sync", async () => {
	const host = await openPlay("sync");
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
		const latest = (globalThis as unknown as { "__netsim": { "view": () => View | undefined } }).__netsim.view();

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

test("each tab observes its own player; no tab hears another's", async () => {
	const host = await openPlay("observe");
	const player = await openPlay("observe");

	await untilInSync(host, 2);
	await until(player, "its client's logs", () => (globalThis as unknown as { "__netsim": { "logs": () => LogEntry[] } }).__netsim.logs().some((record) => record.context?.source === "player-1" && record.message === "joined"));

	const hostSources = await sources(host);
	const playerSources = await sources(player);

	assert.ok(["page", "referee", "player-0"].every((source) => hostSources.has(source)), [...hostSources].join());
	assert.ok(!hostSources.has("player-1") && !hostSources.has("player-1/ui"), `the host hears nothing of the player's tab: ${[...hostSources].join()}`);
	assert.ok(["page", "player-1"].every((source) => playerSources.has(source)), [...playerSources].join());
	assert.ok(!playerSources.has("referee") && !playerSources.has("player-0"), `the player hears nothing of the host's tab: ${[...playerSources].join()}`);

	// The same for the architecture: the hubs that report to each tab are its own — the trees meet only at the
	// player's client, whose reports go to its own tab.
	const reporting = (expected: number) => {
		const hubs = Object.keys((globalThis as unknown as { "__netsim": { "architecture": () => { "topology": Record<string, unknown> } } }).__netsim.architecture().topology).sort();

		return hubs.length >= expected ? hubs : undefined;
	};

	assert.deepEqual(await until(player, "the player's tree", reporting, { "arg": 3 }), ["page", "player-1", "player-1/ui"]);
	assert.deepEqual(await until(host, "the host's tree", reporting, { "arg": 4 }), ["page", "player-0", "player-0/ui", "referee"]);

	// Not even interest crosses: what the player's client asks the host for is its own (the game), never its tab's —
	// its page collecting logs, its instance drawing its view.
	const interest = await until(host, "the referee's link to the player", () => {
		const topology = (globalThis as unknown as { "__netsim": { "architecture": () => { "topology": Record<string, { "links": { "peerId"?: string; "remoteInterest": string[] }[] }> } } }).__netsim.architecture().topology;

		return topology["referee"]?.links.find((link) => link.peerId === "player-1")?.remoteInterest;
	});

	assert.ok(interest.some((subject) => subject.startsWith("netsim.local.state.")), JSON.stringify(interest));
	assert.ok(!interest.some((subject) => subject.startsWith("$sys.log") || subject.startsWith("netsim.local.view")), `the player's tab's interest leaked to the host: ${JSON.stringify(interest)}`);

	await host.close();
	await player.close();
});

test("a player's clicks in their own tab move their unit, on the host's authority", async () => {
	const host = await openPlay("clicks", { "bots": 0 });
	const player = await openPlay("clicks", { "bots": 0 });

	await untilInSync(host, 2);

	const latest = (await view(player))!;
	const [unit] = latest.units.filter((encoded) => encoded[1] === latest.team);
	const frame = player.locator("iframe");
	const box = (await frame.boundingBox())!;
	const width = 24 * FP;
	const toScreen = (x: number, y: number) => [box.x + (x / width) * box.width, box.y + (y / width) * box.height] as const;
	const before = (await tool<{ "seats": { "peer": string; "lastSeq": number }[] }>(host, "netsim_status")).seats.find((seat) => seat.peer === "player-1")!.lastSeq;

	// UNIT_FIELDS: id, team, x, y, …
	await player.mouse.click(...toScreen(unit[2], unit[3]));
	await player.mouse.click(...toScreen(3.5 * FP, 18.5 * FP), { "button": "right" });
	await until(host, "the host's referee to take the player's move", async (from: number) => {
		const netsim = (globalThis as unknown as { "__netsim": { "tool": (name: string) => Promise<{ "seats": { "peer": string; "lastSeq": number }[] }> } }).__netsim;

		return (await netsim.tool("netsim_status")).seats.find((seat) => seat.peer === "player-1")!.lastSeq > from;
	}, { "arg": before });

	const moved = await until(host, "the move in authority", async (id: number) => {
		const netsim = (globalThis as unknown as { "__netsim": { "tool": (name: string) => Promise<{ "units": Unit[] }> } }).__netsim;
		const found = (await netsim.tool("netsim_state")).units.find((candidate) => candidate.id === id);

		return found !== undefined && found.tx !== found.x ? found : undefined;
	}, { "arg": unit[0] });

	assert.ok(Math.abs(moved.tx - 3.5 * FP) < FP / 2 && Math.abs(moved.ty - 18.5 * FP) < FP / 2, JSON.stringify(moved));
	await host.close();
	await player.close();
});

test("a player who reloads their tab keeps their id and seat, and plays on", async () => {
	const host = await openPlay("reload");
	const player = await openPlay("reload");

	await untilInSync(host, 2);

	const { team } = (await status(host)).clients.find((client) => client.peer === "player-1")!;

	await player.reload();
	await until(player, "a place in the match", () => (globalThis as unknown as { "__netsimPlay"?: unknown }).__netsimPlay !== undefined);
	assert.deepEqual(await place(player), { "match": "reload", "role": "player", "peer": "player-1" });
	await until(player, "back in sync", () => (globalThis as unknown as { "__netsim": { "view": () => View | undefined } }).__netsim.view()?.inSync === true);
	await untilInSync(host, 2);

	const seats = (await tool<{ "seats": { "peer": string; "team": number }[] }>(host, "netsim_status")).seats;

	assert.deepEqual(seats.map((seat) => seat.peer).sort(), ["player-0", "player-1"], "no new seat was taken");
	assert.equal(seats.find((seat) => seat.peer === "player-1")!.team, team, "the same seat");
	await host.close();
	await player.close();
});

test("when the host's tab goes, its players are told", async () => {
	const host = await openPlay("leave");
	const player = await openPlay("leave");

	await untilInSync(host, 2);
	await host.close();
	await until(player, "told the host left", () => document.querySelector("#summary")!.textContent!.includes("host left"));
	await player.close();
});
