/**
 * netsim through a real debug-mcp: the page links (the harness relays its :7378 socket to a debug-mcp this test
 * owns), debug-mcp registers the page's tools live, and an MCP client — standing in for an agent — drives the match
 * with them and reads its logs and architecture with debug-mcp's own tools.
 */
import type { Page } from "playwright";
import type { Session } from "./harness.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDebugMcp } from "@brianjenkins94/debug-mcp";
import type { TestClient } from "@brianjenkins94/debug-mcp/testing";
import { connectTestClient } from "@brianjenkins94/debug-mcp/testing";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { until } from "@brianjenkins94/util/until";
import { FP } from "../../src/sim/index.ts";
import { startSession } from "./harness.ts";

const NETSIM_TOOLS = ["netsim_command", "netsim_control", "netsim_divergence", "netsim_state", "netsim_status"];

let session: Session;
let debugMcp: ReturnType<typeof createDebugMcp>;
let mcp: TestClient;
let page: Page;
let listChanged = 0;

/** Call an MCP tool; its answer, parsed. Throws with the tool's message when it answers an error. */
async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	const { isError, value } = await mcp.call(name, args);

	if (isError === true) {
		throw new Error(String(value));
	}

	return value as T;
}


before(async () => {
	debugMcp = createDebugMcp({ "port": 0 });

	const port = await debugMcp.whenListening;

	mcp = await connectTestClient(debugMcp);
	mcp.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });
	session = await startSession({ "debugMcpPort": port });
	page = await session.open({ "clients": 2, "bots": 0 });
});

after(async () => {
	await session?.close();
	await mcp?.close();
	await debugMcp?.close();
});

test("a connected match's tools become debug-mcp tools, announced live", async () => {
	const tools = await until("netsim's tools registered", async () => {
		const { "tools": listed } = await mcp.client.listTools();

		return NETSIM_TOOLS.every((name) => listed.some((tool) => tool.name === name)) ? listed : undefined;
	});
	const command = tools.find((tool) => tool.name === "netsim_command")!;

	assert.deepEqual(Object.keys((command.inputSchema as { "properties": object }).properties).filter((key) => key !== "_approved").sort(), ["client", "tab", "type", "units", "x", "y"]);
	assert.ok(listChanged > 0, "the client was told the list changed");
});

test("an agent pauses the match, checks every view against authority, and plays a move — all over MCP", async () => {
	await until("netsim_status callable", async () => call("netsim_status"));
	assert.deepEqual(await call("netsim_control", { "action": "pause" }), { "tick": (await call<{ "tick": number }>("netsim_status")).tick, "paused": true });

	const divergence = await until("every client at the paused tick", async () => {
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

	for (const source of ["page", "referee", "client-0", "client-1"]) {
		const records = await until(`logs from ${source}`, async () => {
			const found = await call<unknown[]>("query_logs", { "source": source });

			return Array.isArray(found) && found.length > 0 ? found : undefined;
		});

		assert.ok(records.length > 0);
	}

	const architecture = await until("the hub tree", async () => {
		const snapshot = await call<{ "nodes": { "id": string }[]; "channels": { "a": string; "b": string }[] }>("get_architecture");

		return ["page", "referee", "client-0", "client-1"].every((id) => snapshot.nodes.some((node) => node.id === id)) ? snapshot : undefined;
	});

	assert.ok(architecture.channels.some((channel) => [channel.a, channel.b].sort().join("|") === "client-0|referee"), JSON.stringify(architecture.channels));
});

test("what the page logged before its debug-mcp link was up reaches debug-mcp too — once", async () => {
	// "match starting" is logged ~50ms before the socket opens: it arrives in the page's backlog.
	const records = await until("the startup record", async () => {
		const found = await call<unknown[]>("query_logs", { "source": "page", "textIncludes": "match starting" });

		return found.length > 0 ? found : undefined;
	});

	assert.equal(records.length, 1);
});

test("two matches in two tabs, one debug-mcp: each tab's logs, architecture and tools stay its own", async () => {
	const second = await session.open({ "clients": 2, "bots": 0 });
	const tabOf = async (which: Page): Promise<string> => which.evaluate(() => (globalThis as unknown as { "__netsim": { "tab": string } }).__netsim.tab);
	const [first, other] = [await tabOf(page), await tabOf(second)];

	await until("both tabs connected", async () => ((await call<unknown[]>("list_tabs")).length === 2 ? true : undefined));

	// Both tabs have a `referee`: each tab's records are its own, and say so.
	for (const tab of [first, other]) {
		const records = await until(`${tab}'s referee logs`, async () => {
			const found = await call<{ "tab"?: string }[]>("query_logs", { "source": "referee", "tab": tab });

			return found.length > 0 ? found : undefined;
		});

		assert.ok(records.every((record) => record.tab === tab), JSON.stringify(records.slice(0, 3)));
	}

	// The architecture isn't merged: without a tab it asks which; with one, that tab's hub tree.
	await assert.rejects(call("get_architecture"), /several editor tabs/u);

	for (const tab of [first, other]) {
		const snapshot = await until(`${tab}'s architecture`, async () => {
			const found = await call<{ "nodes": { "id": string }[] }>("get_architecture", { "tab": tab }).catch(() => undefined);

			return found?.nodes.some((node) => node.id === "referee") === true ? found : undefined;
		});

		assert.equal(snapshot.nodes.filter((node) => node.id === "referee").length, 1);
	}

	// The page tools act on the tab they're told to: pausing one match leaves the other running.
	await assert.rejects(call("netsim_status"), /several editor tabs/u);
	await call("netsim_control", { "action": "pause", "tab": first });
	assert.equal((await call<{ "paused": boolean }>("netsim_status", { "tab": first })).paused, true);
	assert.equal((await call<{ "paused": boolean }>("netsim_status", { "tab": other })).paused, false);
	await call("netsim_control", { "action": "resume", "tab": first });

	// One tab going leaves the tools (the other still serves them).
	await second.close();
	await until("one tab left", async () => ((await call<unknown[]>("list_tabs")).length === 1 ? true : undefined));
	assert.ok((await mcp.client.listTools()).tools.some((tool) => tool.name === "netsim_status"));
});

test("once the last tab serving them is gone, the match's tools are removed", async () => {
	await page.close();
	await until("netsim's tools removed", async () => {
		const { tools } = await mcp.client.listTools();

		return NETSIM_TOOLS.every((name) => !tools.some((tool) => tool.name === name)) ? true : undefined;
	});
	assert.ok(listChanged > 1, "and the client was told");
});
