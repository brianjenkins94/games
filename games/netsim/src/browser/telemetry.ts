/**
 * Observability for every netsim context, on @brianjenkins94/observability: each context logs through a logger whose
 * records ride its hub on `$sys.log.<source>`, reports its place in the topology (links, peers, traffic) on
 * `$sys.arch.<hub id>`, and publishes its uncaught errors. Both planes flow up the hub tree to the page, which
 * collects them — and, on localhost or with `?debug`, forwards everything to a running debug-mcp, where an agent can
 * query logs, the architecture and the live page. In the editor's preview it joins the editor's hub tree instead, and
 * reaches the editor's debug-mcp through it.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { PageTool } from "@brianjenkins94/observability";
import type { LogRecord } from "@brianjenkins94/util/logger";
import { ArchitectureStore, collectArchReports, createArchReporter, installHubCollector, linkDebugMcp, linkPreviewHost, relayLoggerToHub, requestArchSync, servePageTools, tapConsoleAndErrors } from "@brianjenkins94/observability";

/** Wire a (non-root) context: its logger, its architecture reporter, and its uncaught errors. `source` is the log
 *  source — the hub id, so a client's logs fall under the subjects its link permits. */
export function observe(hub: Hub, source = hub.id) {
	const log = relayLoggerToHub(hub, source);

	tapConsoleAndErrors(hub, source);

	return { "log": log, "architecture": createArchReporter(hub) };
}

/**
 * Own a worker's errors once: a worker reports its own uncaught errors over its hub (observe), but an unhandled one
 * is then re-raised in the page that owns it too — so the owner would report it again, as its own. Mark those
 * handled. A worker that failed to load can't report anything; that arrives as a plain Event, and is logged here.
 */
export function ownWorker(worker: Worker, log: ReturnType<typeof observe>["log"], name: string): void {
	worker.addEventListener("error", (event) => {
		if (event instanceof ErrorEvent) {
			event.preventDefault();
		} else {
			log.error("worker failed to load", { "worker": name });
		}
	});
}

/** Wire the root (the page): collect every context's records and architecture reports, and link debug-mcp (serving
 *  `tools` as this tab's own MCP tools). `tab` is undefined when debugging is off (not localhost, no `?debug`). */
export function observeRoot(hub: Hub, { keep = 1000, tools = [] as PageTool[] } = {}) {
	const context = observe(hub);
	const records: LogRecord[] = [];
	const architecture = new ArchitectureStore();

	installHubCollector(hub, (record) => {
		records.push(record);

		if (records.length > keep) {
			records.shift();
		}
	});
	collectArchReports(hub, (report) => { architecture.apply(report); });
	// Ask everyone for their full state once the reporters have had a moment to link in.
	setTimeout(() => { requestArchSync(hub); }, 500);

	// Running in the editor's preview: join the editor's hub tree (its debug-mcp sees this match through the editor's
	// tab). Standalone: link a debug-mcp directly.
	if (linkPreviewHost(hub) === undefined) {
		linkDebugMcp(hub);
	}

	return { ...context, "records": records, "store": architecture, "tab": servePageTools(hub, { "tools": tools }) };
}
