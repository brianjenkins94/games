/**
 * observability, gone: what war2 imports from it, doing nothing — so the zero-knowledge run (compare.ts) builds war2
 * with no self-reporting at all, and whatever the diagram shows comes from the probes alone. (netsim's, W4.)
 */
/* eslint-disable ts/no-unused-vars */
import type { Transport } from "@brianjenkins94/hub";
import { dataChannelTransport } from "@brianjenkins94/hub";

export type PageTool = unknown;

const log = new Proxy({}, { "get": () => () => undefined }) as Record<string, (...args: unknown[]) => void>;

export function observe(_hub: unknown, _options?: unknown) {
	return { "log": log };
}

export function observeApp(_hub: unknown, _options?: unknown) {
	return { "log": log, "records": [], "store": { "snapshot": () => ({}) }, "tab": undefined, "addTools": (_tools: unknown) => undefined };
}

export function ownWorker(_worker: unknown, _onLoadFailure?: () => void): () => void {
	return () => undefined;
}

export type Gauge = unknown;

export function reportMetrics(_hub: unknown, _options?: unknown) {
	return { "gauge": (_name: string, _gauge: unknown) => undefined };
}

export function scopedTransport(transport: Transport, _scope: string, _options?: unknown): Transport {
	return transport;
}

export function frameRateGauge(): Gauge {
	return () => undefined;
}

export function heapGauge(): Gauge {
	return () => undefined;
}

export function durationGauge() {
	return { "record": (_ms: number) => undefined, "gauge": () => undefined };
}

/** Not metered — but still the link's transport: the game runs over it. */
export function meteredDataChannel(channel: RTCDataChannel) {
	return { "transport": dataChannelTransport(channel), "gauge": () => undefined };
}
