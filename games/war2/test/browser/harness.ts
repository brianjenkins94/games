/**
 * Browser-mode test harness: the real runtime — page, referee worker, instance iframes, client workers, hub links
 * (ports and windows within a tab, WebRTC data channels to the referee), observability — in headless Chromium.
 *
 * By default it tests what ships: it builds war2 (util's buildApp) into a temp dir and serves that under the same
 * base Pages would (`/games/war2/`). `WAR2_URL` points it at a running server instead (a dev server:
 * `WAR2_URL=http://localhost:5181/`). netsim's harness (W3, see MIGRATION.md).
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

const APP_ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = "/games/war2/";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".map": "application/json" };

export interface ServeOptions {
	/** Extra vite config for the build (a `resolve.alias`). */
	"overrides"?: InlineConfig;
	/** Rewrite every script served (prepend something to it). */
	"transformScript"?: (source: string) => string;
}

/** Build war2 and serve it statically. Resolves to its URL and a stop. */
export async function serveBuild({ overrides, transformScript }: ServeOptions = {}): Promise<{ "url": string; "stop": () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(fs.tmpdir(), "war2-"));

	await buildApp(APP_ROOT, root, { "baseDir": "games", ...overrides === undefined ? {} : { "overrides": overrides } });

	const out = path.join(root, "docs", "war2");
	const server = createServer((request, response) => {
		const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
		const relative = pathname.startsWith(BASE) ? pathname.slice(BASE.length) || "index.html" : undefined;
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
		"url": `http://localhost:${(server.address() as AddressInfo).port}${BASE}`,
		"stop": async () => {
			await new Promise((resolve) => { server.close(resolve); });
			await fs.rm(root, { "recursive": true, "force": true });
		}
	};
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

export async function startSession({ debugMcpPort }: { "debugMcpPort"?: number } = {}): Promise<Session> {
	const served = process.env["WAR2_URL"] === undefined ? await serveBuild() : { "url": process.env["WAR2_URL"], "stop": async () => {} };
	// CHROME_PATH, else Playwright's own, else the system Chrome (GitHub's runners), else the newest cached one.
	const browser = await launchChromium();
	const context = await browser.newContext({ "viewport": { "width": 1200, "height": 900 } });
	// WAR2_CPU_THROTTLE=4 slows every page's CPU that many times — CI's runners, on a fast machine — to reproduce what
	// only fails there.
	const throttle = Number(process.env["WAR2_CPU_THROTTLE"] ?? 1);

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
			await untilInSync(page, Number(settings["clients"] ?? 2));

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
	return untilTruthy(what, async () => page.evaluate(probe as (arg: unknown) => Promise<unknown>, arg) as Promise<T>, { "timeoutMs": timeoutMs, "sleep": async (ms) => page.waitForTimeout(ms) });
}

interface Status {
	"tick": number | undefined;
	"clients": { "peer": string; "team": number | undefined; "viewTick": number; "state": string; "stats": Record<string, number> }[];
}

/** The host page's status table, as data (`__war2.status()`). */
export async function status(page: Page): Promise<Status> {
	return page.evaluate(() => (globalThis as unknown as { "__war2": { "status": () => Status } }).__war2.status());
}

/** Wait until `count` clients report, all in sync. */
export async function untilInSync(page: Page, count: number): Promise<void> {
	await until(page, `${count} clients in sync`, (expected: number) => {
		const war2 = (globalThis as unknown as { "__war2"?: { "status": () => Status } }).__war2;
		const clients = war2?.status().clients ?? [];

		return clients.length === expected && clients.every((client) => client.state === "in sync");
	}, { "arg": count, "timeoutMs": 20_000 }).catch(async (error: unknown) => {
		throw new Error(`clients never all in sync: ${JSON.stringify((await status(page).catch(() => undefined))?.clients)}`, { "cause": error });
	});
}

/** Call one of the page's MCP tools directly (`__war2.tool`) — the same handlers debug-mcp forwards to. */
export async function tool<T = unknown>(page: Page, name: string, args: Record<string, unknown> = {}): Promise<T> {
	return page.evaluate(async ([toolName, toolArgs]) => (globalThis as unknown as { "__war2": { "tool": (n: string, a: unknown) => Promise<unknown> } }).__war2.tool(toolName, toolArgs), [name, args] as const) as Promise<T>;
}

/** The pathology guard: the referee's detector flagged nothing in this match (an incident flagged by hand doesn't
 *  count). For tests that give deliberate orders — bots wander into the pathing's known faults. */
export async function assertQuiet(page: Page): Promise<void> {
	const incidents = (await tool<{ "id": string; "label": string }[]>(page, "war2_incidents")).filter((incident) => incident.label.startsWith("auto:"));

	if (incidents.length > 0) {
		throw new Error(`pathing incident(s) flagged: ${incidents.map((incident) => `${incident.id} ${incident.label}`).join("; ")} — war2_replay_incident <id> to look, war2_save_incident_test to pin it`);
	}
}
