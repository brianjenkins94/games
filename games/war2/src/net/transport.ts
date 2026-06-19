/**
 * Referee ↔ client transport seam.
 *
 * The referee logic talks to every player through `RefereeClient` — it only knows
 * a client's team and hands it the full visible-unit set each tick (`sendSnapshot`);
 * how that reaches the player is hidden behind the implementation:
 *
 *   • LocalRefereeClient  — the host plays in-process; the full set crosses the
 *                           worker boundary via postMessage as a keyframe payload.
 *   • RemoteRefereeClient — a client reached by framed bytes (RTCDataChannel /
 *                           relay).  Delta-encodes: only changed/new units + dropped
 *                           uids go on the wire, with a periodic full keyframe so the
 *                           stream self-heals on the unreliable channel.
 *
 * To relocate the referee to a server later, the host client also becomes a
 * RemoteRefereeClient and nothing in the referee changes.
 */
import {
    encodeStateUpdate, decodeClientCommand, packetType, PacketType, unitSnapshotChanged,
    type StateUpdatePayload, type UnitSnapshot, type Command,
} from "./protocol";

/** Full keyframe cadence (ticks).  Bounds drift after a dropped delta to ≤ this. */
const KEYFRAME_TICKS = 10;

/** The referee's handle to one connected client. */
export interface RefereeClient {
    readonly team: number;
    /** Commands received from this client (set by the referee). */
    onCommand?: (cmds: Command[], pingTs: number) => void;
    /** Push this client's authoritative fog view (the full visible set this tick). */
    sendSnapshot(tick: number, units: UnitSnapshot[], pingTs: number, speed: number): void;
}

/** In-process client (the host): no wire encoding, no delta — the full set crosses
 *  postMessage as a keyframe (the channel is lossless and bandwidth-free). */
export class LocalRefereeClient implements RefereeClient {
    onCommand?: (cmds: Command[], pingTs: number) => void;
    constructor(public readonly team: number, private readonly post: (snap: StateUpdatePayload) => void) {}
    sendSnapshot(tick: number, units: UnitSnapshot[], pingTs: number, speed: number): void {
        this.post({ tick, keyframe: true, visibleStates: units, removed: [], pingTs, speed });
    }
    /** Feed locally-issued commands in (from the worker message pump). */
    deliverCommands(cmds: Command[], pingTs: number): void { this.onCommand?.(cmds, pingTs); }
}

/** Remote client reached by framed bytes (data channel or relay), delta-encoded. */
export class RemoteRefereeClient implements RefereeClient {
    onCommand?: (cmds: Command[], pingTs: number) => void;
    // Baseline: what we last put on the wire, so we can diff against it.
    private readonly lastSent = new Map<number, UnitSnapshot>();
    private ticks = 0;

    constructor(public readonly team: number, private readonly sendBytes: (ab: ArrayBuffer) => void) {}

    sendSnapshot(tick: number, units: UnitSnapshot[], pingTs: number, speed: number): void {
        let payload: StateUpdatePayload;
        if (this.ticks++ % KEYFRAME_TICKS === 0) {
            // Keyframe: full set; reset the baseline.
            this.lastSent.clear();
            for (const u of units) this.lastSent.set(u.uid, u);
            payload = { tick, keyframe: true, visibleStates: units, removed: [], pingTs, speed };
        } else {
            // Delta: only new/changed units + uids that dropped out of view.
            const changed: UnitSnapshot[] = [];
            const present = new Set<number>();
            for (const u of units) {
                present.add(u.uid);
                const prev = this.lastSent.get(u.uid);
                if (!prev || unitSnapshotChanged(prev, u)) { changed.push(u); this.lastSent.set(u.uid, u); }
            }
            const removed: number[] = [];
            for (const uid of this.lastSent.keys()) if (!present.has(uid)) removed.push(uid);
            for (const uid of removed) this.lastSent.delete(uid);
            payload = { tick, keyframe: false, visibleStates: changed, removed, pingTs, speed };
        }
        this.sendBytes(encodeStateUpdate(payload));
    }

    /** Hand an inbound framed packet from this client to the referee. */
    handleBytes(ab: ArrayBuffer): void {
        if (packetType(ab) !== PacketType.CLIENT_COMMAND) return;
        const p = decodeClientCommand(ab);
        this.onCommand?.(p.cmds, p.pingTs);
    }
}
