/**
 * Browser-mode test harness: the real runtime — page, referee worker, instance iframes, client workers, hub links
 * over MessageChannels, observability — in headless Chromium.
 *
 * By default it tests what ships: it builds netsim (util's buildApp, ~0.1s) into a temp dir and serves that under
 * the same base Pages would (`/games/netsim/`). `NETSIM_URL` points it at a running server instead (a dev server:
 * `NETSIM_URL=http://localhost:5180/`).
 *
 * The page links a debug-mcp on ws://localhost:7378 when one is running; a developer's own is kept out, so a test
 * never depends on (or pollutes) it. `debugMcpPort` relays that socket to the test's own debug-mcp instead.
 */
import type { AddressInfo } from "node:net";
import type { Browser, BrowserContext, Page } from "playwright";
import { createServer } from "node:http";
import { homedir } from "node:os";
import * as path from "node:path";
import * as fs from "@brianjenkins94/util/fs";
import { buildApp } from "@brianjenkins94/util/vite/build";
import { chromium } from "playwright";

const APP_ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = "/games/netsim/";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".map": "application/json" };

/** Build netsim and serve it statically. Resolves to its URL and a stop. */
async function serveBuild(): Promise<{ "url": string; "stop": () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(fs.tmpdir(), "netsim-"));

	await buildApp(APP_ROOT, root, { "baseDir": "games" });

	const out = path.join(root, "docs", "netsim");
	const server = createServer((request, response) => {
		const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
		const relative = pathname.startsWith(BASE) ? pathname.slice(BASE.length) || "index.html" : undefined;
		const file = relative === undefined ? undefined : path.join(out, relative);

		if (file === undefined || !file.startsWith(out) || !fs.existsSync(file)) {
			response.writeHead(404).end();

			return;
		}

		response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
		fs.createReadStream(file).pipe(response);
	});

	await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });

	return {
		"url": `http://localhost:${(server.address() as AddressInfo).port}${BASE}`,
		"stop": async () => {
			await new Promise((resolve) => { server.close(resolve); });
			await fs.rm(root, { "recursive": true, "force": true });
		}
	};
}

/** The newest Chromium in Playwright's browser cache — one an older Playwright downloaded still runs. */
async function cachedChromium(): Promise<string | undefined> {
	const cache = path.join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
	const builds = fs.existsSync(cache) ? (await fs.readdir(cache)).filter((name) => /^chromium(?:_headless_shell)?-\d+$/u.test(name)).sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1])) : [];
	const executables = [
		"chrome-headless-shell-mac-arm64/chrome-headless-shell",
		"chrome-headless-shell-linux64/chrome-headless-shell",
		"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"chrome-linux64/chrome"
	];

	return builds.flatMap((build) => executables.map((executable) => path.join(cache, build, executable))).find((candidate) => fs.existsSync(candidate));
}

/** CHROME_PATH, else Playwright's own Chromium, else the system Chrome (preinstalled on GitHub's runners), else the
 *  newest one in Playwright's cache. */
async function launch(): Promise<Browser> {
	if (process.env["CHROME_PATH"] !== undefined) {
		return chromium.launch({ "executablePath": process.env["CHROME_PATH"] });
	}

	const cached = await cachedChromium();
	const attempts = [{}, { "channel": "chrome" }, ...cached === undefined ? [] : [{ "executablePath": cached }]];
	const errors: unknown[] = [];

	for (const options of attempts) {
		try {
			return await chromium.launch(options);
		} catch (error) {
			errors.push(error);
		}
	}

	throw new AggregateError(errors, "no Chromium to launch: install one (npx playwright install chromium) or set CHROME_PATH");
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

/** Relay the page's debug-mcp socket (:7378) to a debug-mcp on `port`. */
async function bridgeDebugMcp(context: BrowserContext, port: number): Promise<void> {
	await context.routeWebSocket(/:7378/u, (route) => {
		const upstream = new WebSocket(`ws://localhost:${port}`);
		// Text frames: the hub speaks JSON.
		const queued: string[] = [];

		upstream.addEventListener("open", () => {
			for (const message of queued.splice(0)) {
				upstream.send(message);
			}
		});
		upstream.addEventListener("message", (event) => { route.send(event.data as string); });
		upstream.addEventListener("close", () => { void route.close(); });
		route.onMessage((message) => {
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.send(String(message));
			} else {
				queued.push(String(message));
			}
		});
		route.onClose(() => { upstream.close(); });
	});
}

export async function startSession({ debugMcpPort }: { "debugMcpPort"?: number } = {}): Promise<Session> {
	const served = process.env["NETSIM_URL"] === undefined ? await serveBuild() : { "url": process.env["NETSIM_URL"], "stop": async () => {} };
	const browser = await launch();
	const context = await browser.newContext({ "viewport": { "width": 1200, "height": 900 } });

	if (debugMcpPort === undefined) {
		await context.routeWebSocket(/:7378/u, (route) => { void route.close(); });
	} else {
		await bridgeDebugMcp(context, debugMcpPort);
	}

	return {
		"url": served.url,
		"browser": browser,
		"context": context,
		"open": async (settings = {}) => {
			const page = await context.newPage();
			const query = new URLSearchParams(Object.entries(settings).map(([key, value]) => [key, String(value)]));

			await page.goto(served.url + (query.size > 0 ? "?" + query : ""));
			await untilInSync(page, Number(settings["clients"] ?? 3));

			return page;
		},
		"close": async () => {
			await browser.close();
			await served.stop();
		}
	};
}

/** Poll `probe(arg)` in the page until it's truthy; resolves to its value. The probe may be async (polled from here
 *  with `evaluate`, which awaits it — `waitForFunction` would take the pending Promise itself as truthy). */
export async function until<T, A = undefined>(page: Page, what: string, probe: (arg: A) => T | Promise<T>, { arg, timeoutMs = 15_000 }: { "arg"?: A; "timeoutMs"?: number } = {}): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;

	for (;;) {
		try {
			const value = await page.evaluate(probe as (arg: unknown) => Promise<unknown>, arg) as T;

			if (value) {
				return value;
			}
		} catch (error) {
			last = error;
		}

		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`, { "cause": last });
		}

		await page.waitForTimeout(100);
	}
}

interface Status {
	"tick": number | undefined;
	"clients": { "peer": string; "team": number | undefined; "viewTick": number; "state": string; "stats": Record<string, number> }[];
}

/** The host page's status table, as data (`__netsim.status()`). */
export async function status(page: Page): Promise<Status> {
	return page.evaluate(() => (globalThis as unknown as { "__netsim": { "status": () => Status } }).__netsim.status());
}

/** Wait until `count` clients report, all in sync. */
export async function untilInSync(page: Page, count: number): Promise<void> {
	await until(page, `${count} clients in sync`, (expected: number) => {
		const netsim = (globalThis as unknown as { "__netsim"?: { "status": () => Status } }).__netsim;
		const clients = netsim?.status().clients ?? [];

		return clients.length === expected && clients.every((client) => client.state === "in sync");
	}, { "arg": count, "timeoutMs": 20_000 }).catch(async (error: unknown) => {
		throw new Error(`clients never all in sync: ${JSON.stringify((await status(page).catch(() => undefined))?.clients)}`, { "cause": error });
	});
}

/** Call one of the page's MCP tools directly (`__netsim.tool`) — the same handlers debug-mcp forwards to. */
export async function tool<T = unknown>(page: Page, name: string, args: Record<string, unknown> = {}): Promise<T> {
	return page.evaluate(async ([toolName, toolArgs]) => (globalThis as unknown as { "__netsim": { "tool": (n: string, a: unknown) => Promise<unknown> } }).__netsim.tool(toolName, toolArgs), [name, args] as const) as Promise<T>;
}
