/**
 * Browser-mode test harness for a game here: its real runtime — page, referee worker, instance iframes, client workers,
 * hub links (ports and windows within a tab, WebRTC data channels to the referee), observability — in headless Chromium.
 * netsim's, then war2's; shared from W-audit F1 on. A game describes itself once (`Game`) and gets the harness bound to
 * it:
 *
 *     export const game: Game = { "name": "war2", "root": path.resolve(import.meta.dirname, "../.."), … };
 *     export const { serveBuild, startSession, status, untilInSync, tool } = createHarness(game);
 *
 * (Games import this package by path, not as a dependency: pnpm copies a `file:` dependency into its store, under
 * node_modules, where Node won't strip TypeScript's types — and npm can't read `workspace:`. Its own dependencies are
 * its own, installed with it: CI's workspace has `packages/*`.)
 *
 * By default it tests what ships: it builds the game (util's buildApp) into a temp dir and serves that under the same
 * base Pages would (`/games/<name>/`). `<NAME>_URL` points it at a running server instead (a dev server), and
 * `<NAME>_CPU_THROTTLE=4` slows every page's CPU that many times — CI's runners, on a fast machine.
 *
 * The page links a debug-mcp on ws://localhost:7378 when one is running; a developer's own is kept out, so a test
 * never depends on (or pollutes) it. `debugMcpPort` relays that socket to the test's own debug-mcp instead.
 */
import type { AddressInfo } from "node:net";
import type { Browser, BrowserContext, Page } from "playwright";
import type { InlineConfig } from "vite";
import { createServer } from "node:http";
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import { launchChromium } from "@brianjenkins94/util/playwright/chromium";
import { relayWebSocket } from "@brianjenkins94/util/playwright/relay";
import { until as untilTruthy } from "@brianjenkins94/util/until";
import { buildApp } from "@brianjenkins94/util/vite/build";

/** A game, as the harness needs to know it. */
export interface Game {
	/** Its directory name under games/ — its Pages base (`/games/<name>/`) and its env prefix (`WAR2_URL`). */
	"name": string;
	/** Its directory. */
	"root": string;
	/** Its host page's global (`__war2`): `status()`, `tool(name, args)`, `architecture()`, and `<global>Play` on
	 *  play.html. */
	"global": string;
	/** How many clients its host page starts by default (what `open()` waits for when not told). */
	"clients": number;
	/** Query parameters every scenario adds (`map=arena`: a small map, for speed). */
	"query"?: string;
}

export interface ServeOptions {
	/** Extra vite config for the build (a `resolve.alias`). */
	"overrides"?: InlineConfig;
	/** Rewrite every script served (prepend something to it). */
	"transformScript"?: (source: string) => string;
}

export interface Session {
	"url": string;
	"browser": Browser;
	"context": BrowserContext;
	/** Open the host page with these settings (`{ clients: 3, bots: 0 }` → `?clients=3&bots=0`) and wait for every
	 *  client to be in sync. */
	"open": (settings?: Record<string, number | string>) => Promise<Page>;
	"close": () => Promise<void>;
}

export interface Status {
	"tick": number | undefined;
	"clients": { "peer": string; "team": number | undefined; "viewTick": number; "state": string; "stats": Record<string, number> }[];
}

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".map": "application/json" };

/** Poll `probe(arg)` in the page until it's truthy; resolves to its value. The probe may be async (polled from here
 *  with `evaluate`, which awaits it — `waitForFunction` would take the pending Promise itself as truthy). */
export async function until<T, A = undefined>(page: Page, what: string, probe: (arg: A) => T | Promise<T>, { arg, timeoutMs = 15_000 }: { "arg"?: A; "timeoutMs"?: number } = {}): Promise<T> {
	return untilTruthy(what, async () => page.evaluate(probe as (arg: unknown) => Promise<unknown>, arg) as Promise<T>, { "timeoutMs": timeoutMs, "sleep": async (ms) => page.waitForTimeout(ms) });
}

export function createHarness(game: Game) {
	const base = `/games/${game.name}/`;
	const env = (key: string): string | undefined => process.env[`${game.name.toUpperCase()}_${key}`];

	/** Build the game and serve it statically. Resolves to its URL and a stop. */
	async function serveBuild({ overrides, transformScript }: ServeOptions = {}): Promise<{ "url": string; "stop": () => Promise<void> }> {
		const root = await fs.mkdtemp(path.join(fs.tmpdir(), `${game.name}-`));

		await buildApp(game.root, root, { "baseDir": "games", ...overrides === undefined ? {} : { "overrides": overrides } });

		const out = path.join(root, "docs", game.name);
		const server = createServer((request, response) => {
			const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
			const relative = pathname.startsWith(base) ? pathname.slice(base.length) || "index.html" : undefined;
			const file = relative === undefined ? undefined : path.join(out, relative);

			if (file === undefined || !file.startsWith(out) || !fs.existsSync(file)) {
				response.writeHead(404).end();

				return;
			}

			response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });

			if (transformScript !== undefined && path.extname(file) === ".js") {
				response.end(transformScript(fs.readFileSync(file)));
			} else {
				fs.createReadStream(file).pipe(response);
			}
		});

		await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });

		return {
			"url": `http://localhost:${(server.address() as AddressInfo).port}${base}`,
			"stop": async () => {
				await new Promise((resolve) => { server.close(resolve); });
				await fs.rm(root, { "recursive": true, "force": true });
			}
		};
	}

	/** The host page's status table, as data (`<global>.status()`). */
	async function status(page: Page): Promise<Status> {
		return page.evaluate((global) => (globalThis as unknown as Record<string, { "status": () => Status }>)[global]!.status(), game.global);
	}

	/** Wait until `count` clients report, all in sync. */
	async function untilInSync(page: Page, count: number): Promise<void> {
		await until(page, `${count} clients in sync`, ([expected, global]: [number, string]) => {
			const clients = (globalThis as unknown as Record<string, { "status": () => Status } | undefined>)[global]?.status().clients ?? [];

			return clients.length === expected && clients.every((client) => client.state === "in sync");
		}, { "arg": [count, game.global], "timeoutMs": 20_000 }).catch(async (error: unknown) => {
			throw new Error(`clients never all in sync: ${JSON.stringify((await status(page).catch(() => undefined))?.clients)}`, { "cause": error });
		});
	}

	/** Call one of the page's MCP tools directly (`<global>.tool`) — the same handlers debug-mcp forwards to. */
	async function tool<T = unknown>(page: Page, name: string, args: Record<string, unknown> = {}): Promise<T> {
		return page.evaluate(async ([global, toolName, toolArgs]) => (globalThis as unknown as Record<string, { "tool": (n: string, a: unknown) => Promise<unknown> }>)[global]!.tool(toolName, toolArgs), [game.global, name, args] as const) as Promise<T>;
	}

	async function startSession({ debugMcpPort }: { "debugMcpPort"?: number } = {}): Promise<Session> {
		const url = env("URL");
		const served = url === undefined ? await serveBuild() : { "url": url, "stop": async () => {} };
		// CHROME_PATH, else Playwright's own, else the system Chrome (GitHub's runners), else the newest cached one.
		const browser = await launchChromium();
		const context = await browser.newContext({ "viewport": { "width": 1200, "height": 900 } });
		const throttle = Number(env("CPU_THROTTLE") ?? 1);

		if (throttle > 1) {
			context.on("page", (page) => {
				void context.newCDPSession(page).then(async (cdp) => cdp.send("Emulation.setCPUThrottlingRate", { "rate": throttle }));
			});
		}

		if (debugMcpPort === undefined) {
			await context.routeWebSocket(/:7378/u, (route) => { void route.close(); });
		} else {
			await relayWebSocket(context, /:7378/u, `ws://localhost:${debugMcpPort}`);
		}

		return {
			"url": served.url,
			"browser": browser,
			"context": context,
			"open": async (settings = {}) => {
				const page = await context.newPage();
				const query = new URLSearchParams(Object.entries(settings).map(([key, value]) => [key, String(value)]));

				await page.goto(served.url + (query.size > 0 ? "?" + query : ""));
				await untilInSync(page, Number(settings["clients"] ?? game.clients));

				return page;
			},
			"close": async () => {
				await browser.close();
				await served.stop();
			}
		};
	}

	return { "serveBuild": serveBuild, "startSession": startSession, "status": status, "untilInSync": untilInSync, "tool": tool };
}

export type Harness = ReturnType<typeof createHarness>;
