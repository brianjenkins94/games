/**
 * The zero-knowledge line (W4): probes alone — injected from outside, with war2's own observability stubbed out — draw
 * what war2's self-reported architecture draws: every context, every connection, and the same subjects on its steady data
 * traffic (see zero-knowledge/compare.ts). What the probes see beyond that (another tab's page, through the lobby) is
 * fine; anything today's picture has that theirs doesn't is a regression.
 */
import type { Comparison } from "./zero-knowledge/compare.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareZeroKnowledge, report } from "./zero-knowledge/compare.ts";

/** Labels today's picture has only because war2 reports itself, or that name a protocol step rather than data: hub
 *  control, RPC (today pairs calls and replies by name; probes see the subjects), the observability plane's own. */
function isData(label: string): boolean {
	return !(/^(?:interest \(|hello$|heartbeat$|bye$|↩ )|\(\)$|^\$(?:sys|rpc)\./u).test(label);
}

function holdsTheLine(comparison: Comparison): void {
	const why = report(comparison);

	assert.deepEqual([...comparison.names].filter(([, probes]) => probes === undefined).map(([id]) => id), [], "every context today names, found\n" + why);
	assert.deepEqual(comparison.missing, [], "every connection today draws, found\n" + why);

	// The same subjects on the steady data (a label seen a handful of times or more: one-offs are timing).
	for (const [key, { today, probes }] of comparison.channels) {
		for (const [label, stats] of Object.entries(today?.labels ?? {})) {
			if (isData(label) && stats.count >= 5) {
				assert.ok(probes !== undefined && label in probes.labels, `${key}: \`${label}\` (×${stats.count} today) unnamed by the probes\n${why}`);
			}
		}
	}
}

test("probes alone draw the host page: its frames, their workers, the referee — and every link between them", async () => {
	holdsTheLine(await compareZeroKnowledge("host"));
});

test("probes alone draw a match across tabs: each tab's page, frame and worker, the lobby and its locks, and the referee", async () => {
	holdsTheLine(await compareZeroKnowledge("tabs"));
});
