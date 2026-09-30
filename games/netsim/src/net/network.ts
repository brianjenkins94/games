/**
 * A virtual network for hubs: in-memory links with a simulated clock and seeded fault injection, so a whole match —
 * a referee and N clients — runs in one process, deterministically and instantly.
 *
 * Every frame waits `latencyMs` (± `jitterMs`, which reorders) before delivery, and nothing is delivered until the
 * clock is advanced. Faults (drop, duplicate, jitter) apply only to frames that `faulty` selects — by default game
 * traffic (`netsim.*.commands`, `netsim.*.state.*`). Hub control frames and RPC stay reliable, as they would on a
 * reliable signalling channel beside an unreliable data channel.
 */
import type { Hub, Transport } from "@brianjenkins94/hub";
import { matches } from "@brianjenkins94/hub";
import { createRng, nextU32 } from "../sim/index.ts";

export interface Faults {
	/** Probability (0–1) that a faultable frame is dropped. */
	"drop"?: number;
	/** Probability (0–1) that a faultable frame is delivered twice. */
	"duplicate"?: number;
	/** Base one-way latency. Default 10ms. */
	"latencyMs"?: number;
	/** Extra random latency, 0 to `jitterMs`, per faultable frame — enough of it reorders frames. */
	"jitterMs"?: number;
}

export interface NetworkStats {
	"sent": number;
	"delivered": number;
	"dropped": number;
	"duplicated": number;
}

export interface Network {
	/** Link two hubs over a fresh pair of in-memory transports. Returns an unlink for both ends. */
	"link": (left: Hub, right: Hub, faults?: Faults) => () => void;
	/** Advance the clock by `ms`, delivering every frame due by then (in time order; frames sent during delivery
	 *  that fall due within the window are delivered too). */
	"advance": (ms: number) => void;
	/** Advance until nothing is in flight (bounded, in case two hubs keep each other busy). */
	"settle": (maxMs?: number) => void;
	"now": () => number;
	"stats": NetworkStats;
}

const GAME_TRAFFIC = ["netsim.*.commands", "netsim.*.state.*"];

/** The subject of a hub data frame, or undefined for a control frame. A hub wraps each frame under a private key
 *  (not exported), so find the envelope by shape: the wrapped object with a string `subject` — and no `hub` field,
 *  which marks a control frame (whose sub/unsub also name a subject). */
function subjectOf(frame: unknown): string | undefined {
	if (typeof frame !== "object" || frame === null) {
		return undefined;
	}

	for (const inner of Object.values(frame)) {
		const { hub, subject } = (inner ?? {}) as { "hub"?: unknown; "subject"?: unknown };

		if (typeof subject === "string" && hub === undefined) {
			return subject;
		}
	}

	return undefined;
}

export function createNetwork({ seed = 1, faulty = (subject: string) => GAME_TRAFFIC.some((pattern) => matches(pattern, subject)) } = {}): Network {
	const rng = createRng(seed);
	const chance = (probability: number): boolean => probability > 0 && nextU32(rng) / 0x100000000 < probability;
	const queue: { "at": number; "order": number; "deliver": () => void }[] = [];
	const stats: NetworkStats = { "sent": 0, "delivered": 0, "dropped": 0, "duplicated": 0 };
	let now = 0;
	let order = 0;

	function schedule(at: number, deliver: () => void): void {
		order += 1;
		queue.push({ "at": at, "order": order, "deliver": deliver });
	}

	function endpoint(faults: Faults, peer: () => ((message: unknown) => void) | undefined, self: { "listener"?: (message: unknown) => void }): Transport {
		const latency = faults.latencyMs ?? 10;

		return {
			"send": (message) => {
				stats.sent += 1;

				const subject = subjectOf(message);
				const lossy = subject !== undefined && faulty(subject);
				const deliver = (): void => {
					stats.delivered += 1;
					peer()?.(message);
				};

				if (lossy && chance(faults.drop ?? 0)) {
					stats.dropped += 1;

					return;
				}

				const jitter = lossy && (faults.jitterMs ?? 0) > 0 ? nextU32(rng) % ((faults.jitterMs ?? 0) + 1) : 0;

				schedule(now + latency + jitter, deliver);

				if (lossy && chance(faults.duplicate ?? 0)) {
					stats.duplicated += 1;
					schedule(now + latency + jitter + 1, deliver);
				}
			},
			"listen": (onMessage) => {
				self.listener = onMessage;

				return () => { self.listener = undefined; };
			}
		};
	}

	function advance(ms: number): void {
		const target = now + ms;

		for (;;) {
			let next = -1;

			for (let index = 0; index < queue.length; index += 1) {
				const entry = queue[index];

				if (entry.at <= target && (next === -1 || entry.at < queue[next].at || (entry.at === queue[next].at && entry.order < queue[next].order))) {
					next = index;
				}
			}

			if (next === -1) {
				break;
			}

			const [entry] = queue.splice(next, 1);

			now = entry.at;
			entry.deliver();
		}

		now = target;
	}

	return {
		"link": (left, right, faults = {}) => {
			const leftEnd: { "listener"?: (message: unknown) => void } = {};
			const rightEnd: { "listener"?: (message: unknown) => void } = {};
			const unlinkLeft = left.link(endpoint(faults, () => rightEnd.listener, leftEnd));
			const unlinkRight = right.link(endpoint(faults, () => leftEnd.listener, rightEnd));

			return () => {
				unlinkLeft();
				unlinkRight();
			};
		},
		"advance": advance,
		"settle": (maxMs = 10_000) => {
			const until = now + maxMs;

			while (queue.length > 0 && now < until) {
				advance(Math.max(1, Math.min(...queue.map((entry) => entry.at)) - now));
			}
		},
		"now": () => now,
		"stats": stats
	};
}
