/**
 * The zero-knowledge comparison: netsim's architecture as drawn today (every realm reports itself through its hub —
 * `observe()`, hub topology, the hub tap) against the same match drawn by probes alone (probe.ts injected from outside,
 * observability stubbed out of the build). Every difference is either a missing probe or knowledge the diagram
 * shouldn't need. Prints a markdown report; `--json <file>` also writes both snapshots.
 *
 *     node test/browser/zero-knowledge/compare.ts [--clients 3] [--json out.json]
 */
import type { Page } from "playwright";
import { parseArgs } from "node:util";
import * as path from "node:path";
import { build } from "esbuild";
import * as fs from "@brianjenkins94/util/fs";
import { launchChromium } from "@brianjenkins94/util/playwright/chromium";
import { serveBuild, untilInSync } from "../harness.ts";

interface Snapshot {
	"nodes": { "id": string; "spec": { "role"?: string; "label"?: string } }[];
	"channels": { "a": string; "b": string; "count": number; "linked": boolean; "labels": Record<string, { "count": number; "hub": number }> }[];
}

const { values } = parseArgs({ "options": { "clients": { "type": "string", "default": "3" }, "json": { "type": "string" }, "settle": { "type": "string", "default": "4000" } } });
const clients = Number(values.clients);
const settleMs = Number(values.settle);
const here = import.meta.dirname;

/** probe.ts as one script, to inject anywhere. */
async function probeScript(): Promise<string> {
	const result = await build({ "entryPoints": [path.join(here, "probe.ts")], "bundle": true, "format": "iife", "platform": "browser", "write": false, "logLevel": "silent" });

	return result.outputFiles[0]!.text;
}

/** One run: serve a build, open the host page, wait for the match to settle, read a snapshot. */
async function run(options: Parameters<typeof serveBuild>[0], initScript: string | undefined, read: (page: Page) => Promise<Snapshot>): Promise<Snapshot> {
	const served = await serveBuild(options);
	const browser = await launchChromium();

	try {
		const context = await browser.newContext({ "viewport": { "width": 1200, "height": 900 } });

		await context.routeWebSocket(/:7378/u, (route) => { void route.close(); });

		if (initScript !== undefined) {
			await context.addInitScript({ "content": initScript });
		}

		const page = await context.newPage();

		await page.goto(`${served.url}?clients=${clients}`);
		await untilInSync(page, clients);
		await page.waitForTimeout(settleMs);

		return await read(page);
	} finally {
		await browser.close();
		await served.stop();
	}
}

const probe = await probeScript();

const today = await run({}, undefined, async (page) => page.evaluate(() => (globalThis as unknown as { "__netsim": { "architecture": () => Snapshot } }).__netsim.architecture()));
const probesOnly = await run({
	"overrides": { "resolve": { "alias": { "@brianjenkins94/observability": path.join(here, "observability-stub.ts") } } },
	"transformScript": (source) => probe + "\n" + source
}, probe, async (page) => page.evaluate(() => (globalThis as unknown as { "__zk": () => Snapshot }).__zk()));

if (values.json !== undefined) {
	await fs.writeFile(values.json, JSON.stringify({ "today": today, "probesOnly": probesOnly }, undefined, 2));
}

// ── The comparison ──────────────────────────────────────────────────────────────────────────────────────────────────
// The one thing the harness has to supply: which of today's names (roles the app gave its hubs) is which of the
// probes' names (what the platform calls the realm). That it has to is itself a finding.

const probeIds = probesOnly.nodes.map((node) => node.id);

function counterpart(id: string): string | undefined {
	if (id === "page") {
		return probeIds.find((candidate) => (/^window:\/games\/netsim\/(?:index\.html)?(?:\?|$)/u).test(candidate));
	}

	const ui = (/^(.+)\/ui$/u).exec(id);

	if (ui !== null) {
		return probeIds.find((candidate) => candidate === "window:" + ui[1]);
	}

	return probeIds.includes(id) ? id : undefined;
}

const mapping = new Map(today.nodes.map((node) => [node.id, counterpart(node.id)]));
const reverse = new Map([...mapping].filter(([, probeId]) => probeId !== undefined).map(([id, probeId]) => [probeId!, id]));
const pairKey = (a: string, b: string): string => [a, b].sort().join(" ⇄ ");
const topLabels = (labels: Snapshot["channels"][number]["labels"], limit = 6): string => Object.entries(labels).sort(([, left], [, right]) => right.count - left.count).slice(0, limit).map(([label, stats]) => `\`${label}\` ×${stats.count}`).join(", ") || "—";

const todayChannels = new Map(today.channels.map((channel) => [pairKey(channel.a, channel.b), channel]));
const probeChannels = new Map(probesOnly.channels.map((channel) => [pairKey(reverse.get(channel.a) ?? channel.a, reverse.get(channel.b) ?? channel.b), channel]));

const lines: string[] = [];

lines.push(`# Zero-knowledge comparison — netsim, ${clients} clients`, "");
lines.push(`Today: ${today.nodes.length} nodes, ${today.channels.length} channels. Probes only: ${probesOnly.nodes.length} nodes, ${probesOnly.channels.length} channels.`, "");
lines.push("## Names", "", "| today | probes only |", "|---|---|");

for (const [id, probeId] of mapping) {
	lines.push(`| \`${id}\` | ${probeId === undefined ? "**missing**" : "`" + probeId + "`"} |`);
}

for (const id of probeIds.filter((candidate) => !reverse.has(candidate))) {
	lines.push(`| **absent** | \`${id}\` |`);
}

lines.push("", "## Channels", "", "| between | today | probes only |", "|---|---|---|");

for (const key of [...new Set([...todayChannels.keys(), ...probeChannels.keys()])].sort()) {
	const before = todayChannels.get(key);
	const after = probeChannels.get(key);

	lines.push(`| ${key} | ${before === undefined ? "**absent**" : `${before.linked ? "hub link · " : ""}${before.count} msgs: ${topLabels(before.labels)}`} | ${after === undefined ? "**missing**" : `${after.count} msgs: ${topLabels(after.labels)}`} |`);
}

console.log(lines.join("\n"));
