/**
 * The HUD and command card in the browser (W3c-2): a player in their own window (play.html — the game fills it)
 * builds a farm and trains a worker through the card exactly as they would play — select, hotkeys, the placement ghost,
 * a card slot, the status strip — each step landing on the referee.
 */
import type { Frame, Page } from "playwright";
import type { Session } from "./harness.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startSession, tool, until } from "./harness.ts";

const TILE = 32_000;

interface Unit { "uid": number; "team": number; "type": string; "x": number; "y": number; "building"?: { "w": number; "h": number; "buildLeft": number }; "production"?: { "queue": string[] } }
interface State { "tick": number; "units": Unit[]; "clients": { "peer": string; "team": number; "view": Unit[] }[] }
interface Instance { "latest": () => { "team": number; "units": Unit[]; "selected": number[] } | undefined; "ready": () => boolean; "card": () => (string | null)[] | null; "canPlace": (x: number, y: number, type: string) => boolean; "toScreen": (x: number, y: number) => { "x": number; "y": number }; "lookAt": (x: number, y: number) => void }

let session: Session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close();
});

/** The player's window: play.html, hosting a fresh match, with its instance's renderer up. */
async function openWindow(): Promise<{ "page": Page; "instance": Frame }> {
	const page = await session.context.newPage();

	await page.setViewportSize({ "width": 1280, "height": 800 });
	await page.goto(`${session.url}play.html?match=hud-${Date.now()}&bots=0&perTeam=4`);

	// The iframe is there before its document is: wait for the instance's own frame.
	let instance: Frame | undefined;

	for (let attempt = 0; attempt < 200 && instance === undefined; attempt += 1) {
		instance = page.frames().find((frame) => frame.url().includes("instance.html"));

		if (instance === undefined) {
			await page.waitForTimeout(50);
		}
	}

	assert.ok(instance !== undefined, "the instance frame loaded");

	await until(instance as unknown as Page, "the renderer ready", () => (globalThis as unknown as { "__war2Instance": Instance }).__war2Instance.ready(), { "timeoutMs": 20_000 });

	return { "page": page, "instance": instance };
}

/** Call one of the instance's script hooks (`__war2Instance.<method>(...args)`) and get its answer. */
async function call<T>(instance: Frame, method: keyof Instance, ...args: unknown[]): Promise<T> {
	return instance.evaluate(([name, values]) => ((globalThis as unknown as { "__war2Instance": Record<string, (...rest: unknown[]) => unknown> }).__war2Instance[name])(...values), [method, args] as const) as Promise<T>;
}

/** The player's own units, as its view has them. */
async function own(instance: Frame): Promise<Unit[]> {
	const latest = await call<{ "team": number; "units": Unit[] }>(instance, "latest");

	return latest.units.filter((unit) => unit.team === latest.team);
}

/** Click a world point (FP) in the instance, the camera looking at it first. */
async function clickWorld(page: Page, instance: Frame, x: number, y: number, button: "left" | "right" = "left"): Promise<void> {
	const box = (await page.locator("iframe").boundingBox())!;

	await call(instance, "lookAt", x, y);
	await page.waitForTimeout(100);

	const at = await call<{ "x": number; "y": number }>(instance, "toScreen", x, y);

	await page.mouse.click(box.x + at.x, box.y + at.y, { "button": button });
}

async function lastSeq(page: Page): Promise<number> {
	return (await tool<{ "seats": { "peer": string; "lastSeq": number }[] }>(page, "war2_status")).seats.find((seat) => seat.peer === "player-0")!.lastSeq;
}

test("a worker builds a farm through the card: select it, B for the build menu, F for a farm, the ghost, a click on open ground", async () => {
	const { page, instance } = await openWindow();
	const units = await own(instance);
	const peasant = units.find((unit) => unit.type === "unit-peasant")!;
	const hall = units.find((unit) => unit.type === "unit-town-hall")!;

	await clickWorld(page, instance, peasant.x, peasant.y);
	await until(instance as unknown as Page, "the peasant selected, its card up", (uid: number) => {
		const war2 = (globalThis as unknown as { "__war2Instance": Instance }).__war2Instance;

		return war2.latest()?.selected.includes(uid) && war2.card()?.[6] === "build-basic";
	}, { "arg": peasant.uid });

	await page.keyboard.press("b");
	assert.equal((await call<(string | null)[]>(instance, "card"))[0], "build:unit-farm", "B: the build menu");
	await page.keyboard.press("f");

	// A spot by the town hall where the ghost says a farm fits.
	const [hx, hy] = [Math.floor(hall.x / TILE) - 2, Math.floor(hall.y / TILE) - 2];
	const spots: [number, number][] = [[hx + 5, hy], [hx - 3, hy], [hx, hy + 5], [hx, hy - 3], [hx + 5, hy + 3], [hx - 3, hy + 3]];
	const fits = await Promise.all(spots.map(async ([x, y]) => call<boolean>(instance, "canPlace", x, y, "unit-farm")));
	const spot = spots.find((_, index) => fits[index]);
	const seq = await lastSeq(page);

	assert.ok(spot !== undefined, "somewhere by the hall to put a farm");
	// The ghost centres its footprint on the cursor: a 2×2's top-left is the tile up and left of it.
	await clickWorld(page, instance, (spot[0] + 1) * TILE, (spot[1] + 1) * TILE);
	await until(page, "the referee to take the build", async (from: number) => (await (globalThis as unknown as { "__war2": { "tool": (name: string) => Promise<{ "seats": { "peer": string; "lastSeq": number }[] }> } }).__war2.tool("war2_status")).seats.find((seat) => seat.peer === "player-0")!.lastSeq > from, { "arg": seq });

	const farm = await until(page, "the farm on the map", async ([x, y]: [number, number]) => {
		const state = await (globalThis as unknown as { "__war2": { "tool": (name: string) => Promise<State> } }).__war2.tool("war2_state");

		return state.units.find((unit) => unit.type === "unit-farm" && Math.floor(unit.x / 32_000) === x + 1 && Math.floor(unit.y / 32_000) === y + 1);
	}, { "arg": spot });

	assert.equal(farm.team, 0);
	assert.ok(farm.building!.buildLeft > 0, "under construction");
	await page.close();
});

test("a town hall trains a peasant from its card, the queue shows in the status strip, and clicking it there cancels it", async () => {
	const { page, instance } = await openWindow();
	const hall = (await own(instance)).find((unit) => unit.type === "unit-town-hall")!;

	await clickWorld(page, instance, hall.x, hall.y);
	await until(instance as unknown as Page, "the hall's card", () => (globalThis as unknown as { "__war2Instance": Instance }).__war2Instance.card()?.[0] === "train:unit-peasant");
	await instance.locator("#hud-card [data-ability=\"train:unit-peasant\"]").click();

	const queued = await until(page, "a peasant in training", async (uid: number) => {
		const state = await (globalThis as unknown as { "__war2": { "tool": (name: string) => Promise<State> } }).__war2.tool("war2_state");

		return state.units.find((unit) => unit.uid === uid)?.production;
	}, { "arg": hall.uid });

	assert.deepEqual(queued.queue, ["unit-peasant"]);
	// Paused, the peasant can't finish training (45 ticks) before we've looked — the view stays, the strip with it.
	await tool(page, "war2_control", { "action": "pause" });
	await instance.locator(".hud-status [data-production=\"0\"]").waitFor({ "timeout": 15_000 }).catch(async (error: unknown) => {
		// What the instance and the referee had instead (a CI failure can't be watched).
		const seen = {
			"instance": await instance.evaluate((uid) => {
				const war2 = (globalThis as unknown as { "__war2Instance": { "latest": () => { "team": number; "viewTick": number; "selected": number[]; "units": Unit[] } | undefined; "selected": () => number[] } }).__war2Instance;
				const latest = war2.latest();

				return { "viewTick": latest?.viewTick, "selectedByWorker": latest?.selected, "selectedByRenderer": war2.selected(), "hall": latest?.units.find((unit) => unit.uid === uid), "strip": document.querySelector(".hud-status")?.outerHTML.slice(0, 300) };
			}, hall.uid),
			"referee": (await tool<State>(page, "war2_state")).units.find((unit) => unit.uid === hall.uid),
			"status": await tool(page, "war2_status")
		};

		throw new Error(`the production item never showed\nseen: ${JSON.stringify(seen).slice(0, 3000)}`, { "cause": error });
	});

	// The strip is refreshed with every view, but its item stays the same element (a click needs its mousedown and
	// mouseup on one): ten views later, still attached.
	const item = await instance.locator(".hud-status [data-production=\"0\"]").elementHandle();

	await page.waitForTimeout(500);
	assert.equal(await item!.evaluate((element) => element.isConnected), true, "the production item wasn't rebuilt under the pointer");
	const seq = await lastSeq(page);

	await instance.locator(".hud-status [data-production=\"0\"]").click();
	// The cancel reaches the referee, which applies it on its next tick.
	await until(page, "the referee to take the cancel", async (from: number) => (await (globalThis as unknown as { "__war2": { "tool": (name: string) => Promise<{ "seats": { "peer": string; "lastSeq": number }[] }> } }).__war2.tool("war2_status")).seats.find((seat) => seat.peer === "player-0")!.lastSeq > from, { "arg": seq });
	await tool(page, "war2_control", { "action": "step", "ticks": 1 });
	await until(page, "the training cancelled", async (uid: number) => {
		const state = await (globalThis as unknown as { "__war2": { "tool": (name: string) => Promise<State> } }).__war2.tool("war2_state");

		return state.units.find((unit) => unit.uid === uid)?.production === undefined;
	}, { "arg": hall.uid });
	await instance.locator(".hud-status [data-production]").waitFor({ "state": "detached" });
	await page.close();
});
