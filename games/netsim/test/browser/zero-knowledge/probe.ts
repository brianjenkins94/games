/**
 * The zero-knowledge probe: what an IDE that knows nothing of the app it runs could install in every realm — before the
 * app's own code — and learn from. Bundled to one script (compare.ts) and injected from outside the app: into every
 * window and frame as an init script, and ahead of every script the server serves (so a worker gets it too). The app
 * isn't asked for anything: no hub, no `observe()`, no names.
 *
 * Each realm names itself from what the platform says it is — a window as the page embedding it calls its frame, else by
 * its URL (observability's windowName), a worker by its `name` option or its script; read each time, since a frame's first window (about:blank) is the one its page goes on
 * in — and records what its probes see (every channel, hub frames included: to the probe a hub
 * is just an app) on a BroadcastChannel of the observer's own, opened before the probes wrap BroadcastChannel. The top
 * window collects every realm's reports into an ArchitectureStore: `globalThis.__zk()` is its snapshot.
 */
import type { ArchNodeSpec, ArchReport, ArchSink, NodeOp, TrafficCount, TrafficKind } from "@brianjenkins94/observability";
import { ArchitectureStore, installNetworkProbes, installWindowMessageProbe, installWorkerProbe, windowName } from "@brianjenkins94/observability";

const CHANNEL = "\0zero-knowledge-probe";
const FLUSH_MS = 250;

type ProbeScope = typeof globalThis & { "__zkProbe"?: true; "__zk"?: () => unknown };

function workerId(): string {
	const scope = globalThis as unknown as { "name"?: string; "location": Location };

	return scope.name !== undefined && scope.name !== "" ? scope.name : "worker:" + (scope.location.pathname.split("/").pop() ?? "worker");
}

function install(): void {
	const scope = globalThis as ProbeScope;

	if (scope.__zkProbe === true) {
		return;
	}

	scope.__zkProbe = true;

	const isWindow = typeof window !== "undefined";
	const selfId = (): string => (isWindow ? windowName(window) : workerId());
	let named: string | undefined;
	// Ours, before the probes wrap the constructor: the observer's channel is the one thing it doesn't observe.
	const channel = new BroadcastChannel(CHANNEL);
	const counts = new Map<string, TrafficCount>();
	let nodes: NodeOp[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let top: ArchitectureStore | undefined;

	const deliver = (report: ArchReport): void => {
		if (top === undefined) {
			channel.postMessage(report);
		} else {
			top.apply(report);
		}
	};
	const flush = (): void => {
		const self = selfId();

		timer = undefined;

		// Said who it is (again, if its window went on to a page): first, so its traffic lands on it.
		if (named !== self) {
			nodes.unshift({ "op": "spawn", "spec": { "id": self, "role": isWindow ? "window" : "worker" } });
			named = self;
		}

		deliver({ "reporter": self, "time": Date.now(), "nodes": nodes, "traffic": [...counts.values()] });
		nodes = [];
		counts.clear();
	};
	const schedule = (): void => {
		timer ??= setTimeout(flush, FLUSH_MS);
	};
	const sink: ArchSink = {
		get "self"() { return selfId(); },
		"declare": (spec: ArchNodeSpec) => { nodes.push({ "op": "declare", "spec": spec }); schedule(); },
		"spawn": (spec: ArchNodeSpec) => { nodes.push({ "op": "spawn", "spec": spec }); schedule(); },
		"terminate": (id: string) => { nodes.push({ "op": "terminate", "id": id }); schedule(); },
		"state": (id, state) => { nodes.push({ "op": "state", "id": id, "state": state }); schedule(); },
		"record": (from: string, to: string, kind: TrafficKind, label: string, bytes = 0, count = 1) => {
			const key = [from, to, kind, label].join("\0");
			const entry = counts.get(key) ?? { "from": from, "to": to, "kind": kind, "label": label, "count": 0, "bytes": 0 };

			entry.count += count;
			entry.bytes += bytes;
			counts.set(key, entry);
			schedule();
		}
	};

	if (isWindow && window.top === window) {
		top = new ArchitectureStore();
		channel.addEventListener("message", (event) => { top!.apply(event.data as ArchReport); });
		scope.__zk = () => top!.snapshot();
	}

	installNetworkProbes(sink, { "hubFrames": "record" });
	installWorkerProbe(sink, undefined, { "hubFrames": "record" });
	installWindowMessageProbe(sink, undefined, { "hubFrames": "record" });
	schedule();
}

try {
	install();
} catch { /* the observer never breaks the app */ }
