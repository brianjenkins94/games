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

/** What a message on a data channel weighs: its text's length, or its binary's. */
function weight(data: unknown): number {
	if (typeof data === "string") {
		return data.length;
	}

	return (data as { "byteLength"?: number; "size"?: number } | null)?.byteLength ?? (data as { "size"?: number } | null)?.size ?? 0;
}

/** KB/s `channel` sent and received since the last reading — `in` and `out`, what it actually carried (the hub's frames,
 *  already serialized: nothing is serialized again to weigh them). Wrap the channel before anything sends on it. */
export function wireGauge(channel: RTCDataChannel): Gauge {
	let sent = 0;
	let received = 0;
	let since = performance.now();
	const send = channel.send.bind(channel) as (data: unknown) => void;

	channel.send = ((data: unknown) => {
		sent += weight(data);
		send(data);
	}) as RTCDataChannel["send"];
	channel.addEventListener("message", (event) => { received += weight(event.data); });

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
