/**
 * netsim through a real debug-mcp: the page links (the harness relays its :7378 socket to a debug-mcp this test
 * owns), debug-mcp registers the page's tools live, and an MCP client — standing in for an agent — drives the match
 * with them and reads its logs and architecture with debug-mcp's own tools.
 */
import type { AddressInfo } from "node:net";
import type { Page } from "playwright";
import type { Session } from "./harness.ts";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { createDebugMcp } from "@brianjenkins94/debug-mcp";
import { createMcpServer } from "@brianjenkins94/debug-mcp/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { FP } from "../../src/sim/index.ts";
import { startSession } from "./harness.ts";

const NETSIM_TOOLS = ["netsim_command", "netsim_control", "netsim_divergence", "netsim_state", "netsim_status"];

let session: Session;
let debugMcp: { "whenListening": Promise<void>; "close": () => Promise<void> };
let client: Client;
let page: Page;
let listChanged = 0;

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const probe = createServer().listen(0, () => {
			const { port } = probe.address() as AddressInfo;

			probe.close(() => { resolve(port); });
		});
	});
}

/** Call an MCP tool; its answer, parsed. Throws with the tool's message when it answers an error. */
async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	const result = await client.callTool({ "name": name, "arguments": args }) as { "isError"?: boolean; "content": { "text": string }[] };
	const text = result.content[0]?.text ?? "";

	if (result.isError === true) {
		throw new Error(text);
	}

	try {
		return JSON.parse(text) as T;
	} catch {
		return text as T;
	}
}

async function eventually<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		const value = await probe().catch(() => undefined);

		if (value) {
			return value;
		}

		if (Date.now() > deadline) {
			throw new Error("timed out waiting for " + what);
		}

		await new Promise((resolve) => { setTimeout(resolve, 100); });
	}
}

before(async () => {
	const port = await freePort();

	debugMcp = createDebugMcp({ "port": port });
	await debugMcp.whenListening;

	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

	await createMcpServer(debugMcp).connect(serverSide);
	client = new Client({ "name": "netsim-test", "version": "0.0.0" });
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });
	await client.connect(clientSide);
	session = await startSession({ "debugMcpPort": port });
	page = await session.open({ "clients": 2, "bots": 0 });
});

after(async () => {
	await session?.close();
	await client?.close();
	await debugMcp?.close();
});

test("a connected match's tools become debug-mcp tools, announced live", async () => {
	const tools = await eventually("netsim's tools registered", async () => {
		const { "tools": listed } = await client.listTools();

		return NETSIM_TOOLS.every((name) => listed.some((tool) => tool.name === name)) ? listed : undefined;
	});
	const command = tools.find((tool) => tool.name === "netsim_command")!;

	assert.deepEqual(Object.keys((command.inputSchema as { "properties": object }).properties).filter((key) => key !== "_approved").sort(), ["client", "tab", "type", "units", "x", "y"]);
	assert.ok(listChanged > 0, "the client was told the list changed");
});

test("an agent pauses the match, checks every view against authority, and plays a move — all over MCP", async () => {
	await eventually("netsim_status callable", async () => call("netsim_status"));
	assert.deepEqual(await call("netsim_control", { "action": "pause" }), { "tick": (await call<{ "tick": number }>("netsim_status")).tick, "paused": true });

	const divergence = await eventually("every client at the paused tick", async () => {
		const answer = await call<{ "clients": { "peer": string; "comparable": boolean; "identical": boolean }[] }>("netsim_divergence");

		return answer.clients.every((entry) => entry.comparable) ? answer : undefined;
	});

	assert.deepEqual(divergence.clients.map((entry) => [entry.peer, entry.identical]), [["client-0", true], ["client-1", true]]);

	const state = await call<{ "units": { "id": number; "team": number; "tx": number; "ty": number }[]; "clients": { "peer": string; "team": number }[] }>("netsim_state");
	const team = state.clients.find((entry) => entry.peer === "client-0")!.team;
	const unit = state.units.find((candidate) => candidate.team === team)!;
	const played = await call<{ "ok": boolean; "received": boolean }>("netsim_command", { "client": "client-0", "type": "move", "units": [unit.id], "x": 7, "y": 9 });

	assert.deepEqual([played.ok, played.received], [true, true]);
	await call("netsim_control", { "action": "step", "ticks": 2 });

	const moved = (await call<typeof state>("netsim_state")).units.find((candidate) => candidate.id === unit.id)!;

	assert.deepEqual([moved.tx, moved.ty], [7 * FP, 9 * FP]);
	await call("netsim_control", { "action": "resume" });
});

test("debug-mcp's own tools see the match: its tab, every context's logs, the hub tree", async () => {
	const tabs = await call<{ "tab": string; "url": string }[]>("list_tabs");

	assert.equal(tabs.length, 1);
	assert.match(tabs[0].url, /\/games\/netsim\//u);

	// (Not the page's own "match starting": it's logged before the debug-mcp link is up — see the todo below.)
	for (const source of ["referee", "client-0", "client-1"]) {
		const records = await eventually(`logs from ${source}`, async () => {
			const found = await call<unknown[]>("query_logs", { "source": source });

			return Array.isArray(found) && found.length > 0 ? found : undefined;
		});

		assert.ok(records.length > 0);
	}

	const architecture = await eventually("the hub tree", async () => {
		const snapshot = await call<{ "nodes": { "id": string }[]; "channels": { "a": string; "b": string }[] }>("get_architecture");

		return ["page", "referee", "client-0", "client-1"].every((id) => snapshot.nodes.some((node) => node.id === id)) ? snapshot : undefined;
	});

	assert.ok(architecture.channels.some((channel) => [channel.a, channel.b].sort().join("|") === "client-0|referee"), JSON.stringify(architecture.channels));
});

test("what a page logged before debug-mcp connected reaches debug-mcp too", { "todo": "GAPS.md: records from before the debug-mcp link is up are never sent" }, async () => {
	const records = await call<unknown[]>("query_logs", { "source": "page", "textIncludes": "match starting" });

	assert.equal(records.length, 1);
});

test("once the match's tab is gone, its tools stay listed but answer that nothing serves them", async () => {
	await page.close();
	await eventually("the tab gone", async () => ((await call<unknown[]>("list_tabs")).length === 0 ? true : undefined));

	// GAPS.md: util/mcp can't remove a tool, so it stays listed.
	assert.ok((await client.listTools()).tools.some((tool) => tool.name === "netsim_status"));
	await assert.rejects(call("netsim_status"), /no editor tab is connected/u);
});
