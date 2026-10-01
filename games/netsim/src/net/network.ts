/**
 * A virtual network for hubs: in-memory links with a simulated clock and seeded fault injection, so a whole match —
 * a referee and N clients — runs in one process, deterministically and instantly.
 *
 * Every frame waits `latencyMs` (± `jitterMs`, which reorders) before delivery, and nothing is delivered until the
 * clock is advanced. Faults (drop, duplicate, jitter) apply only to frames that `faulty` selects — by default game
 * traffic (`netsim.*.commands`, `netsim.*.state.*`). Hub control frames and RPC stay reliable, as they would on a
 * reliable signalling channel beside an unreliable data channel.
 */
import type { Hub, LinkOptions, Transport } from "@brianjenkins94/hub";
import { frameOf, matches, pipe } from "@brianjenkins94/hub";
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
	/** Link two hubs over a fresh pair of in-memory transports, with each end's hub link options (e.g. the id and
	 *  permissions `left` assigns `right`) and, in `through`, what each end's transport passes through first (e.g. the
	 *  edge naming what arrives: observability's scopedTransport). Returns an unlink for both ends. */
	"link": (left: Hub, right: Hub, faults?: Faults, options?: { "left"?: LinkOptions; "right"?: LinkOptions; "through"?: { "left"?: (transport: Transport) => Transport; "right"?: (transport: Transport) => Transport } }) => () => void;
	/** Advance the clock by `ms`, delivering every frame due by then (in time order; frames sent during delivery
	 *  that fall due within the window are delivered too). */
	"advance": (ms: number) => void;
	/** Advance until nothing is in flight (bounded, in case two hubs keep each other busy). */
	"settle": (maxMs?: number) => void;
	"now": () => number;
	"stats": NetworkStats;
}

const GAME_TRAFFIC = ["netsim.*.commands", "netsim.*.state.*"];

export function createNetwork({ seed = 1, faulty = (subject: string) => GAME_TRAFFIC.some((pattern) => matches(pattern, subject)) } = {}): Network {
	const rng = createRng(seed);
	const chance = (probability: number): boolean => probability > 0 && nextU32(rng) / 0x100000000 < probability;
	const queue: { "at": number; "order": number; "deliver": () => void }[] = [];
	const stats: NetworkStats = { "sent": 0, "delivered": 0, "dropped": 0, "duplicated": 0 };
	let now = 0;
	let order = 0;

	function enqueue(at: number, deliver: () => void): void {
		order += 1;
		queue.push({ "at": at, "order": order, "deliver": deliver });
	}

	/** How each frame on a link travels (hub's pipe asks): on the simulated clock, with this link's faults applied to
	 *  faultable data frames. Control frames (which carry a `hub` field) and RPC stay reliable. */
	function travel(faults: Faults) {
		const latency = faults.latencyMs ?? 10;

		return (deliver: () => void, message: unknown): void => {
			stats.sent += 1;

			const frame = frameOf(message);
			const lossy = frame !== undefined && !("hub" in frame) && faulty(frame.subject);
			const counted = (): void => {
				stats.delivered += 1;
				deliver();
			};

			if (lossy && chance(faults.drop ?? 0)) {
				stats.dropped += 1;

				return;
			}

			const jitter = lossy && (faults.jitterMs ?? 0) > 0 ? nextU32(rng) % ((faults.jitterMs ?? 0) + 1) : 0;

			enqueue(now + latency + jitter, counted);

			if (lossy && chance(faults.duplicate ?? 0)) {
				stats.duplicated += 1;
				enqueue(now + latency + jitter + 1, counted);
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
		"link": (left, right, faults = {}, options = {}) => {
			const [leftEnd, rightEnd] = pipe({ "schedule": travel(faults) });
			const unlinkLeft = left.link(options.through?.left?.(leftEnd) ?? leftEnd, options.left);
			const unlinkRight = right.link(options.through?.right?.(rightEnd) ?? rightEnd, options.right);

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
