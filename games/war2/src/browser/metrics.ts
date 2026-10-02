/**
 * war2's gauges on the metrics plane (observability's `reportMetrics`: `$sys.metrics.<source>`, sampled once a second) —
 * what its old dashboard charted, per box: frame rate, the sim tick, how far behind the referee a client is, the wire, the
 * heap. Nothing here draws them: any viewer on the tree does — the editor's monitor (a card per gauge, a line per
 * client), debug-mcp's query_metrics.
 *
 * Who reports what: each client window its `fps` and `heap`; each client worker its `units` and `wire`; the referee its
 * `tickMs`; the host page each client's `lag` — how many ticks its view is behind the referee's (the old chart's
 * round-trip time has no counterpart yet: nothing times a round trip to the referee).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Gauge } from "@brianjenkins94/observability";

/** Frames this window drew per second since the last reading (requestAnimationFrame callbacks). */
export function frameRateGauge(): Gauge {
	let frames = 0;
	let since = performance.now();
	const count = (): void => {
		frames += 1;
		requestAnimationFrame(count);
	};

	requestAnimationFrame(count);

	return () => {
		const now = performance.now();
		const fps = (frames * 1000) / (now - since);

		frames = 0;
		since = now;

		return fps;
	};
}

/** This window's JavaScript heap (MB): Chromium's `performance.memory` — none elsewhere, nor in a worker. */
export function heapGauge(): Gauge {
	return () => {
		const memory = (performance as Performance & { "memory"?: { "usedJSHeapSize": number } }).memory;

		return memory === undefined ? undefined : memory.usedJSHeapSize / 1048576;
	};
}

/** KB/s this hub sent and received on its link to `peer` since the last reading — `in` and `out`, frames counted by their
 *  JSON size (what a data channel carries). */
export function wireGauge(hub: Hub, peer: string): Gauge {
	let sent = 0;
	let received = 0;
	let since = performance.now();

	hub.tap((event) => {
		if ((event.type === "send" || event.type === "receive") && event.link.peerId === peer) {
			const bytes = JSON.stringify(event.frame)?.length ?? 0;

			if (event.type === "send") {
				sent += bytes;
			} else {
				received += bytes;
			}
		}
	});

	return () => {
		const now = performance.now();
		const seconds = (now - since) / 1000;
		const rates = { "in": received / 1024 / seconds, "out": sent / 1024 / seconds };

		sent = 0;
		received = 0;
		since = now;

		return rates;
	};
}

/** How long something took (ms), `record`ed each time it runs — read as the `mean` and `max` since the last reading, or
 *  nothing when it didn't run (a paused referee). */
export function durationGauge(): { "record": (ms: number) => void; "gauge": Gauge } {
	let total = 0;
	let count = 0;
	let max = 0;

	return {
		"record": (ms) => {
			total += ms;
			count += 1;
			max = Math.max(max, ms);
		},
		"gauge": () => {
			if (count === 0) {
				return undefined;
			}

			const reading = { "mean": total / count, "max": max };

			total = 0;
			count = 0;
			max = 0;

			return reading;
		}
	};
}
