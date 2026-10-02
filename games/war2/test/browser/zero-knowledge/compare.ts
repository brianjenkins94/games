/**
 * The zero-knowledge comparison (netsim's, carried to war2 in W4 — see MIGRATION.md): war2's architecture as drawn today (every realm reports itself through its hub —
 * `observe()`, hub topology, the hub tap) against the same match drawn by probes alone (probe.ts injected from outside,
 * observability stubbed out of the build). Every difference is either a missing probe or knowledge the diagram
 * shouldn't need. Two scenarios: `host` (one page, its instance frames) and `tabs` (play.html in two tabs: a host and
 * a player, through the lobby). zero-knowledge.test.ts holds the line; run directly, it prints a markdown report:
 *
 *     node test/browser/zero-knowledge/compare.ts [--scenario host|tabs] [--clients 3] [--json out.json]
 */
import type { Page } from "playwright";
import type { ServeOptions } from "../harness.ts";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { build } from "vite";
import * as fs from "@brianjenkins94/util/fs";
import { isEntry } from "@brianjenkins94/util/env";
import { launchChromium } from "@brianjenkins94/util/playwright/chromium";
import { serveBuild, until, untilInSync } from "../harness.ts";

interface Channel { "a": string; "b": string; "count": number; "linked": boolean; "medium"?: string; "labels": Record<string, { "count": number; "hub": number }> }

export interface Snapshot {
	"nodes": { "id": string; "spec": { "role"?: string; "label"?: string } }[];
	"channels": Channel[];
	"media"?: { "id": string; "between": [string, string] }[];
}

export type Scenario = "host" | "tabs";

export interface Comparison {
	"scenario": Scenario;
	"today": Snapshot;
	"probesOnly": Snapshot;
	/** Each of today's nodes and its counterpart in the probes' picture (undefined: missing) — a medium the probes draw
	 *  as the edge through it, as `⇄ <its ends>`. */
	"names": Map<string, string | undefined>;
	/** What the probes see that today's picture doesn't name. */
	"extraNames": string[];
	/** Per pair of today's ends (`a ⇄ b`, sorted): today's channel, and the probes' that accounts for it. */
	"channels": Map<string, { "today"?: Channel; "probes"?: Channel }>;
	/** Today's channels the probes don't account for. */
	"missing": string[];
}

const here = import.meta.dirname;
const pairKey = (a: string, b: string): string => [a, b].sort().join(" ⇄ ");

/** probe.ts as one script, to inject anywhere. */
async function probeScript(): Promise<string> {
	const result = await build({
		"configFile": false,
		"logLevel": "silent",
		"build": { "write": false, "minify": false, "lib": { "entry": path.join(here, "probe.ts"), "formats": ["iife"], "name": "zeroKnowledgeProbe" } }
	});
	const output = (Array.isArray(result) ? result[0] : result) as { "output": { "type": string; "code"?: string }[] };

	return output.output.find((chunk) => chunk.type === "chunk")!.code!;
}

interface Tab { "page": Page; "name": string }

/** One run of a scenario: serve a build, open its tabs, let the match settle, `read` the result from them. */
async function run<T>(scenario: Scenario, clients: number, settleMs: number, options: ServeOptions, initScript: string | undefined, read: (tabs: Tab[]) => Promise<T>): Promise<T> {
	const served = await serveBuild(options);
	const browser = await launchChromium();

	try {
		const context = await browser.newContext({ "viewport": { "width": 1200, "height": 900 } });

		await context.routeWebSocket(/:7378/u, (route) => { void route.close(); });

		if (initScript !== undefined) {
			await context.addInitScript({ "content": initScript });
		}

		const open = async (url: string): Promise<Page> => {
			const page = await context.newPage();

			await page.goto(url);

			return page;
		};
		let tabs: Tab[];

		if (scenario === "host") {
			tabs = [{ "page": await open(`${served.url}?clients=${clients}&map=arena`), "name": "host" }];
			await untilInSync(tabs[0]!.page, clients);
		} else {
			const host = await open(`${served.url}play.html?match=zk&map=arena`);

			await until(host, "the host's place", () => (globalThis as unknown as { "__war2Play"?: unknown }).__war2Play !== undefined);

			const player = await open(`${served.url}play.html?match=zk&map=arena`);

			tabs = [{ "page": host, "name": "host" }, { "page": player, "name": "player" }];
			await untilInSync(host, 2);
		}

		await tabs[0]!.page.waitForTimeout(settleMs);

		return await read(tabs);
	} finally {
		await browser.close();
		await served.stop();
	}
}

/** Today's picture, across tabs: each tab's own, its page named by its tab (`page@player`) — everything else has one
 *  name in every tab. A channel two tabs both report is kept once. */
async function todays(tabs: Tab[]): Promise<Snapshot> {
	const union: Snapshot = { "nodes": [], "channels": [] };
	const seen = new Set<string>();
	const pairs = new Set<string>();

	for (const { page, name } of tabs) {
		const snapshot = await page.evaluate(() => (globalThis as unknown as { "__war2": { "architecture": () => Snapshot } }).__war2.architecture());
		const rename = (id: string): string => (id === "page" && tabs.length > 1 ? "page@" + name : id);

		for (const node of snapshot.nodes) {
			if (!seen.has(rename(node.id))) {
				seen.add(rename(node.id));
				union.nodes.push({ ...node, "id": rename(node.id) });
			}
		}

		for (const channel of snapshot.channels) {
			const renamed = { ...channel, "a": rename(channel.a), "b": rename(channel.b) };

			if (!pairs.has(pairKey(renamed.a, renamed.b))) {
				pairs.add(pairKey(renamed.a, renamed.b));
				union.channels.push(renamed);
			}
		}
	}

	return union;
}

export async function compareZeroKnowledge(scenario: Scenario, { clients = 3, settleMs = 4000 }: { "clients"?: number; "settleMs"?: number } = {}): Promise<Comparison> {
	const probe = await probeScript();
	const today = await run(scenario, clients, settleMs, {}, undefined, todays);
	const { probesOnly, pages } = await run(scenario, clients, settleMs, {
		"overrides": { "resolve": { "alias": { "@brianjenkins94/observability": path.join(here, "observability-stub.ts") } } },
		"transformScript": (source) => probe + "\n" + source
	}, probe, async (tabs) => ({
		"probesOnly": await tabs[0]!.page.evaluate(() => (globalThis as unknown as { "__zk": () => Snapshot }).__zk()),
		"pages": new Map(await Promise.all(tabs.map(async ({ page, name }) => [name, await page.evaluate(() => (globalThis as unknown as { "__zkSelf": () => string }).__zkSelf())] as const)))
	}));

	// The one thing the harness has to supply: which of today's names (roles the app gave its hubs) is which of the
	// probes' names (what the platform calls the realm) — a tab's page, by the tab it's in.
	const probeIds = new Set(probesOnly.nodes.map((node) => node.id));
	const counterpart = (id: string): string | undefined => {
		const page = (/^page(?:@(.+))?$/u).exec(id);

		if (page !== null) {
			return pages.get(page[1] ?? "host");
		}

		const ui = (/^(.+)\/ui$/u).exec(id);
		const candidate = ui === null ? id : "window:" + ui[1];

		return probeIds.has(candidate) ? candidate : undefined;
	};
	const names = new Map(today.nodes.map((node) => [node.id, counterpart(node.id)]));
	const todayOf = new Map([...names].filter(([, probeId]) => probeId !== undefined).map(([id, probeId]) => [probeId!, id]));
	const media = new Map((probesOnly.media ?? []).map((medium) => [medium.id, medium.between.map((end) => todayOf.get(end) ?? end)]));

	for (const [id, ends] of media) {
		if (names.has(id)) {
			names.set(id, "⇄ " + ends.join(" ⇄ "));
		}
	}
	const channels = new Map<string, { "today"?: Channel; "probes"?: Channel }>();

	for (const channel of probesOnly.channels) {
		channels.set(pairKey(todayOf.get(channel.a) ?? channel.a, todayOf.get(channel.b) ?? channel.b), { "probes": channel });
	}

	// A channel today draws to a medium (a tab's page ⇄ the lobby's channel) is accounted for by the probes' edge through
	// it — the medium only two contexts use, drawn between them.
	const accountFor = (channel: Channel): Channel | undefined => {
		const direct = channels.get(pairKey(channel.a, channel.b))?.probes;

		if (direct !== undefined) {
			return direct;
		}

		for (const [medium, ends] of media) {
			const end = channel.a === medium ? channel.b : channel.b === medium ? channel.a : undefined;

			if (end !== undefined && ends.includes(end)) {
				return channels.get(pairKey(ends[0]!, ends[1]!))?.probes;
			}
		}

		return undefined;
	};
	const missing: string[] = [];

	for (const channel of today.channels) {
		const key = pairKey(channel.a, channel.b);
		const probes = accountFor(channel);

		channels.set(key, { ...channels.get(key), "today": channel, "probes": probes });

		if (probes === undefined) {
			missing.push(key);
		}
	}

	return { "scenario": scenario, "today": today, "probesOnly": probesOnly, "names": names, "extraNames": [...probeIds].filter((id) => !todayOf.has(id) && !media.has(id)), "channels": channels, "missing": missing };
}

/** A comparison as a markdown report. */
export function report(comparison: Comparison): string {
	const { today, probesOnly } = comparison;
	const topLabels = (labels: Channel["labels"], limit = 6): string => Object.entries(labels).sort(([, left], [, right]) => right.count - left.count).slice(0, limit).map(([label, stats]) => `\`${label}\` ×${stats.count}`).join(", ") || "—";
	const lines = [
		`# Zero-knowledge comparison — war2, ${comparison.scenario}`,
		"",
		`Today: ${today.nodes.length} nodes, ${today.channels.length} channels. Probes only: ${probesOnly.nodes.length} nodes, ${probesOnly.channels.length} channels${(probesOnly.media ?? []).length > 0 ? `, ${probesOnly.media!.length} drawn as the edge through them` : ""}.`,
		"",
		"## Names",
		"",
		"| today | probes only |",
		"|---|---|",
		...[...comparison.names].map(([id, probeId]) => `| \`${id}\` | ${probeId === undefined ? "**missing**" : probeId.startsWith("⇄ ") ? "the edge " + probeId.slice(2) : "`" + probeId + "`"} |`),
		...comparison.extraNames.map((id) => `| **absent** | \`${id}\` |`),
		"",
		"## Channels",
		"",
		"| between | today | probes only |",
		"|---|---|---|",
		...[...comparison.channels].sort(([left], [right]) => left.localeCompare(right)).map(([key, { "today": before, "probes": after }]) => `| ${key} | ${before === undefined ? "**absent**" : `${before.linked ? "hub link · " : ""}${before.count} msgs: ${topLabels(before.labels)}`} | ${after === undefined ? "**missing**" : `${after.medium === undefined ? "" : "via `" + after.medium + "` · "}${after.count} msgs: ${topLabels(after.labels)}`} |`)
	];

	return lines.join("\n");
}

if (isEntry(import.meta)) {
	const { values } = parseArgs({ "options": { "scenario": { "type": "string" }, "clients": { "type": "string", "default": "3" }, "json": { "type": "string" }, "settle": { "type": "string", "default": "4000" } } });
	const scenarios: Scenario[] = values.scenario === undefined ? ["host", "tabs"] : [values.scenario as Scenario];
	const results: Comparison[] = [];

	for (const scenario of scenarios) {
		results.push(await compareZeroKnowledge(scenario, { "clients": Number(values.clients), "settleMs": Number(values.settle) }));
	}

	if (values.json !== undefined) {
		await fs.writeFile(values.json, JSON.stringify(results.map(({ scenario, today, probesOnly }) => ({ "scenario": scenario, "today": today, "probesOnly": probesOnly })), undefined, 2));
	}

	console.log(results.map(report).join("\n\n"));
}
