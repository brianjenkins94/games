/**
 * Worker-side console relay.
 *
 * A worker (referee.worker / client.worker) has no DOM, so it can't render the in-game console overlay
 * (debug/console.ts) itself, and its console output lands in a separate DevTools context that's easy to
 * miss.  This patches the worker's `console.*` (and its uncaught error / rejection handlers) to forward
 * each line to the main thread, which feeds it into the box's overlay via `pushConsole`.  The original
 * console is still called, so the worker's own DevTools context keeps working.  Dev only.
 */
export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

function format(args: unknown[]): string {
    return args.map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
}

/** Patch this worker's console to also `forward(level, msg)` to the main thread. Idempotent-ish; call once. */
export function forwardWorkerConsole(forward: (level: ConsoleLevel, msg: string) => void): void {
    if (!import.meta.env.DEV) return;
    for (const level of ["log", "info", "warn", "error", "debug"] as ConsoleLevel[]) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            try { forward(level, format(args)); } catch { /* never let the relay break logging */ }
            original(...args);
        };
    }
    self.addEventListener("error", (e) => forward("error", `Uncaught ${e.message}  (${e.filename}:${e.lineno})`));
    self.addEventListener("unhandledrejection", (e) => forward("error", `Unhandled rejection: ${format([(e as PromiseRejectionEvent).reason])}`));
}
