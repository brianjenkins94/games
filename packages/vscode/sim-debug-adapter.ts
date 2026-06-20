/**
 * Inline Debug Adapter (DAP) that drives a stepped game simulation from VS Code's debug UI.
 *
 * Pure protocol logic — no `vscode` import — so it's portable and testable on its own. The workbench
 * entry wraps it into a `vscode.DebugAdapter` (an `onDidSendMessage` emitter + `handleMessage`) and a
 * `DebugAdapterInlineImplementation`. Two seams:
 *   • `send`    — emit a DAP message to VS Code (responses + events).
 *   • `control` — emit a sim-control message to the game (pause/resume/step/state-request); the host
 *                 relays it to the authoritative box, and sim events come back via `onSimEvent`.
 *
 * Maps VS Code's debug toolbar onto the sim: continue→resume, pause→pause, step-over→one tick. The
 * Variables panel renders the sim's `SimDebugState` (tick/paused/hash + every unit's components).
 */

/** Sim control messages (a subset of the game's MainToWorker debug kinds). */
export type SimControl =
    | { kind: "pause" } | { kind: "resume" } | { kind: "step" } | { kind: "debug-state-request" }
    | { kind: "set-breakpoints"; exprs: string[] }
    | { kind: "set-data-breakpoints"; ids: string[] }
    | { kind: "set-reverse"; enabled: boolean }
    | { kind: "step-back" }
    | { kind: "reverse-continue" };

/** Sim events the adapter consumes (a subset of the game's WorkerToMain debug kinds). */
export type SimEvent =
    | { kind: "stopped"; tick: number; reason: "pause" | "step" | "breakpoint"; hit?: string }
    | { kind: "debug-state"; state: SimDebugState };

interface SimDebugUnit {
    uid: number; type: number; team: number; x: number; y: number; dir: number; moving: number;
    moveActive: number; mtx: number; mty: number; fw: number; fh: number; buildLeft: number;
}
interface SimDebugState { tick: number; paused: boolean; hash: number; units: SimDebugUnit[]; }

// Stable variablesReference handles (>0 means expandable). Units expand to UNIT_BASE + uid.
const REF_SIM = 1, REF_UNITS = 2, UNIT_BASE = 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dap = any;

export class SimDebugAdapter {
    private seq = 1;
    private state: SimDebugState | null = null;
    private stoppedTick: number | null = null;   // authoritative tick from the latest stopped event

    constructor(
        private readonly send: (message: Dap) => void,
        private readonly control: (msg: SimControl) => void,
    ) {}

    /** Handle a DAP request from VS Code. */
    handleMessage(message: Dap): void {
        if (message.type !== "request") return;
        const { command, arguments: args, seq } = message;
        const respond = (body?: unknown) => this.send({ seq: this.seq++, type: "response", request_seq: seq, success: true, command, body });

        switch (command) {
            case "initialize":
                respond({
                    supportsConfigurationDoneRequest: true, supportsTerminateRequest: true,
                    // Reverse debugging via a per-tick snapshot ring (the sim is deterministic) — adds
                    // the Step Back + Reverse Continue toolbar buttons.
                    supportsStepBack: true,
                    // Breakpoints: function breakpoints carry a sim expression (the "name"); data
                    // breakpoints watch a Variables value for change. Both evaluate per-tick in the sim.
                    supportsFunctionBreakpoints: true, supportsConditionalBreakpoints: true, supportsDataBreakpoints: true,
                });
                this.event("initialized");
                break;
            case "attach":
            case "launch":
                respond();
                break;
            case "configurationDone":
                respond();
                this.control({ kind: "set-reverse", enabled: true });   // record snapshots for reverse stepping
                this.control({ kind: "debug-state-request" });          // seed the Variables panel
                break;
            case "threads":
                respond({ threads: [{ id: 1, name: "sim" }] });
                break;
            case "stackTrace":
                // Use the tick from the stopped event — it's authoritative and arrives before the
                // debug-state message that updates `this.state` (VS Code requests stackTrace in between).
                respond({ stackFrames: [{ id: 1, name: `tick ${this.stoppedTick ?? this.state?.tick ?? "?"}`, line: 0, column: 0 }], totalFrames: 1 });
                break;
            case "scopes":
                respond({ scopes: [
                    { name: "Sim", variablesReference: REF_SIM, expensive: false },
                    { name: `Units (${this.state?.units.length ?? 0})`, variablesReference: REF_UNITS, expensive: false },
                ] });
                break;
            case "variables":
                respond({ variables: this.variables(args.variablesReference) });
                break;
            case "setFunctionBreakpoints": {
                // Repurpose each function breakpoint's free-text "name" as a sim expression (e.g.
                // `count < 5`, `unit(3).buildLeft === 0`); an optional condition is ANDed in.
                const bps: { name?: string; condition?: string }[] = args?.breakpoints ?? [];
                const exprs = bps
                    .map((b) => (b.condition ? `(${b.name}) && (${b.condition})` : String(b.name ?? "")).trim())
                    .filter((e) => e !== "");
                this.control({ kind: "set-breakpoints", exprs });
                respond({ breakpoints: bps.map(() => ({ verified: true })) });
                break;
            }
            case "dataBreakpointInfo": {
                // Offer break-on-change for sim.hash and any unit field (not tick — it changes every tick).
                const ref = Number(args?.variablesReference), name = String(args?.name ?? "");
                let dataId: string | null = null;
                if (ref === REF_SIM && name === "hash") dataId = "sim.hash";
                else if (ref >= UNIT_BASE) dataId = `unit.${ref - UNIT_BASE}.${name}`;
                respond(dataId
                    ? { dataId, description: dataId, accessTypes: ["write"], canPersist: false }
                    : { dataId: null, description: "not watchable" });
                break;
            }
            case "setDataBreakpoints": {
                const ids: string[] = (args?.breakpoints ?? []).map((b: { dataId?: string }) => String(b.dataId ?? "")).filter((id: string) => id !== "");
                this.control({ kind: "set-data-breakpoints", ids });
                respond({ breakpoints: ids.map(() => ({ verified: true })) });
                break;
            }
            case "continue":
                this.control({ kind: "resume" });
                respond({ allThreadsContinued: true });
                break;
            case "next":          // step over → one sim tick
            case "stepIn":
            case "stepOut":
                this.control({ kind: "step" });
                respond();        // the sim's "stopped" event drives the UI back to a halt
                break;
            case "stepBack":      // reverse one tick (restore the previous snapshot)
                this.control({ kind: "step-back" });
                respond();
                break;
            case "reverseContinue":   // rewind until a breakpoint, or to the earliest snapshot
                this.control({ kind: "reverse-continue" });
                respond({ allThreadsContinued: true });
                break;
            case "pause":
                this.control({ kind: "pause" });
                respond();
                break;
            case "evaluate":
                respond({ result: this.evaluate(String(args?.expression ?? "")), variablesReference: 0 });
                break;
            case "disconnect":
            case "terminate":
                this.control({ kind: "set-reverse", enabled: false });   // stop recording + free the ring
                this.control({ kind: "resume" });   // don't leave the sim frozen on detach
                respond();
                break;
            default:
                respond();        // acknowledge anything else so VS Code isn't left waiting
        }
    }

    /** Handle a sim event relayed from the game. */
    onSimEvent(msg: SimEvent): void {
        if (msg.kind === "stopped") {
            this.stoppedTick = msg.tick;   // authoritative for the stack frame (precedes debug-state)
            // VS Code renders "Paused on <reason>"; `description`/`text` surface which breakpoint hit.
            this.event("stopped", { reason: msg.reason, description: msg.hit, text: msg.hit, threadId: 1, allThreadsStopped: true });
        } else if (msg.kind === "debug-state") {
            this.state = msg.state;
        }
    }

    private event(event: string, body?: unknown): void {
        this.send({ seq: this.seq++, type: "event", event, body });
    }

    private variables(ref: number): Dap[] {
        const v = (name: string, value: unknown, variablesReference = 0) => ({ name, value: String(value), variablesReference });
        if (ref === REF_SIM) {
            const s = this.state;
            return [v("tick", s?.tick ?? "?"), v("paused", s?.paused ?? "?"), v("hash", s?.hash ?? "?"), v("units", s?.units.length ?? 0)];
        }
        if (ref === REF_UNITS) {
            return (this.state?.units ?? []).map((u) => v(`#${u.uid}`, `type ${u.type} team ${u.team} @(${u.x},${u.y})`, UNIT_BASE + u.uid));
        }
        if (ref >= UNIT_BASE) {
            const u = this.state?.units.find((x) => x.uid === ref - UNIT_BASE);
            if (!u) return [];
            return [
                v("uid", u.uid), v("type", u.type), v("team", u.team),
                v("x", u.x), v("y", u.y), v("dir", u.dir), v("moving", u.moving),
                v("moveActive", u.moveActive), v("moveTarget", `(${u.mtx},${u.mty})`),
                v("footprint", `${u.fw}×${u.fh}`), v("buildLeft", u.buildLeft),
            ];
        }
        return [];
    }

    private evaluate(expr: string): string {
        const s = this.state;
        if (!s) return "(no state yet)";
        if (expr === "tick") return String(s.tick);
        if (expr === "units") return String(s.units.length);
        if (expr === "paused") return String(s.paused);
        if (expr === "hash") return String(s.hash);
        const m = /^unit\((\d+)\)$/.exec(expr.trim());
        if (m) { const u = s.units.find((x) => x.uid === Number(m[1])); return u ? JSON.stringify(u) : "undefined"; }
        return "(unsupported)";
    }
}
