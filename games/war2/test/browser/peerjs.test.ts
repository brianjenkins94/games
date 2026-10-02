/**
 * W2's first step, the open risk (MIGRATION.md): can war2 keep PeerJS — its broker for finding players, its TURN relays
 * for reaching them — and still give hub what it needs? That's a reliable, ordered data channel, in the worker (the old
 * client handed the channel over in PeerJS's `open`, too late to transfer, so every packet relayed through the page).
 *
 * Two players, each its own browser context, find each other through a local PeerJS broker. Each hands its end of the
 * channel to a worker as it's created — the dialer straight from `peer.connect()`, the answerer from the peer
 * connection's `datachannel` event — and the workers link hubs over it: a round trip each way, then a stream of
 * sequenced messages that must all arrive, in order.
 */
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as path from "node:path";
import { after, before, test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";
import { launchChromium } from "@brianjenkins94/util/playwright/chromium";
import { buildApp } from "@brianjenkins94/util/vite/build";
import { startBroker } from "./broker.ts";

const FIXTURE = path.resolve(import.meta.dirname, "peerjs");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json" };

let browser: Browser;
let stops: (() => Promise<void>)[] = [];
let site: string;
let broker: number;

/** Listen on a free port; resolves to it. */
async function listen(server: ReturnType<typeof createServer>): Promise<number> {
	await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
	stops.push(async () => { server.closeAllConnections(); await new Promise((resolve) => { server.close(resolve); }); });

	return (server.address() as AddressInfo).port;
}

before(async () => {
	// The broker: PeerJS's own server, as war2 ran locally on :9000 (and PeerJS cloud stands in for when deployed).
	const started = await startBroker();

	stops.push(async () => { started.stop(); });
	broker = started.port;

	// The probe page, built as an app is (util's buildApp), served under its base.
	const root = await fs.mkdtemp(path.join(fs.tmpdir(), "war2-peerjs-"));

	stops.push(async () => { await fs.rm(root, { "recursive": true, "force": true }); });
	await buildApp(FIXTURE, root);

	const out = path.join(root, "docs", "peerjs");
	const port = await listen(createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname.replace(/^\/peerjs\//u, "/");
		const file = path.join(out, pathname === "/" ? "index.html" : pathname);

		if (!file.startsWith(out) || !fs.existsSync(file)) {
			response.writeHead(404).end();

			return;
		}

		response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
		fs.createReadStream(file).pipe(response);
	}));

	site = `http://localhost:${port}/peerjs/`;
	browser = await launchChromium();
});

after(async () => {
	await browser?.close();

	for (const stop of stops.reverse()) {
		await stop();
	}

	stops = [];
});

/** The page's `window.probe` once its worker has reported (or it failed), within `timeoutMs`. */
async function outcome(page: Page, timeoutMs = 30_000): Promise<{ "transferred"?: boolean; "error"?: string; "report"?: Record<string, unknown> }> {
	await page.waitForFunction(() => {
		const probe = (globalThis as { "probe"?: { "error"?: string; "report"?: unknown } }).probe;

		return probe?.error !== undefined || probe?.report !== undefined;
	}, undefined, { "timeout": timeoutMs });

	return await page.evaluate(() => (globalThis as unknown as { "probe": never }).probe);
}

test("a PeerJS data channel goes to the worker as it's created, on both ends, and carries hub reliably, in order", { "timeout": 90_000 }, async () => {
	const [answerer, dialer] = [await browser.newContext(), await browser.newContext()];
	const answer = await answerer.newPage();
	const dial = await dialer.newPage();
	const errors: string[] = [];

	for (const page of [answer, dial]) {
		page.on("pageerror", (error) => { errors.push(error.message); });
	}

	await answer.goto(`${site}?role=answer&id=war2-answer&broker=${broker}`);
	// The answerer has to be registered with the broker before the dialer asks for it.
	await answer.waitForFunction(() => (globalThis as { "probe"?: { "registered"?: boolean } }).probe?.registered === true);
	await dial.goto(`${site}?role=dial&id=war2-dial&target=war2-answer&broker=${broker}`);

	const [dialed, answered] = [await outcome(dial), await outcome(answer)];

	assert.deepEqual(errors, []);
	assert.equal(dialed.error, undefined, "the dialer's end");
	assert.equal(answered.error, undefined, "the answerer's end");
	assert.equal(dialed.transferred, true);
	assert.equal(answered.transferred, true);
	assert.deepEqual(answered.report, { "role": "answer", "ordered": true, "maxRetransmits": null, "pong": { "pong": "answer", "from": "dial" } });
	assert.deepEqual(dialed.report, { "role": "dial", "ordered": true, "maxRetransmits": null, "pong": { "pong": "dial", "from": "answer" }, "sent": 2000, "received": 2000, "inOrder": true });

	await answerer.close();
	await dialer.close();
});

test("handed over in PeerJS's open instead — as the old client did — the channel can't move (so it relayed every packet)", { "timeout": 90_000 }, async () => {
	const [answerer, dialer] = [await browser.newContext(), await browser.newContext()];
	const answer = await answerer.newPage();
	const dial = await dialer.newPage();

	await answer.goto(`${site}?role=answer&id=war2-late-answer&broker=${broker}`);
	await answer.waitForFunction(() => (globalThis as { "probe"?: { "registered"?: boolean } }).probe?.registered === true);
	await dial.goto(`${site}?role=dial&late&id=war2-late-dial&target=war2-late-answer&broker=${broker}`);

	const dialed = await outcome(dial);

	assert.equal(dialed.transferred, undefined);
	assert.match(dialed.error ?? "", /DataCloneError/u);

	await answerer.close();
	await dialer.close();
});
