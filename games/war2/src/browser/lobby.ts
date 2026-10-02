/**
 * A tab's way into a match with players in other tabs: host it, or join it as a player (netsim's, W3 — see
 * MIGRATION.md). Everything here is scoped to the origin (one server), not to a URL — so its tabs meet whatever page or
 * path they were loaded from:
 *
 * - **Who hosts:** a Web Lock per match. The first tab to take it hosts; the browser releases it when that tab goes
 *   (closed, reloaded, crashed), which is also how players learn the host left.
 * - **Who's who:** a Web Lock per player id, held for the tab's life. A tab takes the id it had before a reload if
 *   it's free, else the lowest free one — atomically, with no one to ask.
 * - **Introductions and signaling:** a BroadcastChannel per match. A player's instance (on every load) asks for a
 *   link, under a fresh id; the host accepts, and the two pages trade the WebRTC link's offer, answer and candidates
 *   over the same channel, addressed by that id (rtc.ts). The game then runs over the data channel, between the two
 *   workers — nothing else of either tab crosses it.
 *
 * Same-origin tabs are trusted: any of them can open the lobby channel, take a lock or claim a player id. That's the
 * editor's preview and a local dev server; across machines, players would need another way to signal.
 */

import type { MakeLink, Signal, Signaling } from "./rtc.ts";
import { answerLink, linkLabel, offerLink } from "./rtc.ts";

/** On the match's lobby channel. */
type LobbyMessage =
	/** player → host: link my instance's client, as `link`. Repeated until accepted. */
	| { "type": "connect"; "peer": string; "link": string }
	/** host → player: accepted — its signals follow. */
	| { "type": "accepted"; "link": string }
	/** Either way: a WebRTC signal for link `link`. */
	| { "type": "signal"; "link": string; "from": "host" | "player"; "signal": Signal };

/** Signaling for link `link` over the lobby, as `me`: it hears only the other end's signals for that link — and holds
 *  any that come before it has a handler. */
function lobbySignaling(lobby: BroadcastChannel, link: string, me: "host" | "player"): Signaling {
	let handler: ((signal: Signal) => void) | undefined;
	const early: Signal[] = [];

	lobby.addEventListener("message", (event: MessageEvent<LobbyMessage>) => {
		const message = event.data;

		if (message.type === "signal" && message.link === link && message.from !== me) {
			if (handler === undefined) {
				early.push(message.signal);
			} else {
				handler(message.signal);
			}
		}
	});

	return {
		"send": (signal) => { lobby.postMessage({ "type": "signal", "link": link, "from": me, "signal": signal } satisfies LobbyMessage); },
		"onSignal": (next) => {
			handler = next;

			for (const signal of early.splice(0)) {
				next(signal);
			}
		}
	};
}

interface Common {
	"match": string;
	/** This tab's player id: `player-0` for the host. */
	"peer": string;
	/** Leave the match (a host's leaving ends it). */
	"close": () => void;
}

/** A tab's place in a match — through this module's lobby (tabs of one browser) or PeerJS's (peerLobby.ts: players on
 *  other machines). Either way the host gets, for each player link, the referee's end of it; a player makes its own. */
export type Lobby =
	| Common & { "role": "host"; /** Each time a player's instance needs a link to the referee: the referee's end of it. */ "onPlayer": (handler: (peer: string, link: MakeLink) => void) => void }
	| Common & { "role": "player"; /** A fresh link to the host's referee: its client's end (resolves once the host has accepted it). */ "link": (take: (channel: RTCDataChannel) => void) => Promise<{ "close": () => void }>; "onHostLeft": (handler: () => void) => void };

/** How often a player repeats an unanswered `connect` (a host still starting up hasn't heard it). */
const RETRY_MS = 250;

function remembered(key: string): string | undefined {
	try {
		return sessionStorage.getItem(key) ?? undefined;
	} catch {
		return undefined;
	}
}

function remember(key: string, value: string): void {
	try {
		sessionStorage.setItem(key, value);
	} catch { /* no storage: a reload joins as a new player */ }
}

/** Take lock `name` if it's free, and hold it until `release` resolves (or the tab goes). Resolves whether it got it. */
async function hold(name: string, release: Promise<void>): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		void navigator.locks.request(name, { "ifAvailable": true }, async (lock) => {
			resolve(lock !== null);

			if (lock !== null) {
				await release;
			}
		});
	});
}

/** Join match `match`: this tab hosts it if nobody does yet, else joins it as a player. */
export async function joinLobby(match: string): Promise<Lobby> {
	const prefix = `war2.${match}`;
	const peerKey = `${prefix}.peer`;
	const hostLock = `${prefix}.host`;
	const lobby = new BroadcastChannel(`${prefix}.lobby`);
	let leave = (): void => undefined;
	const released = new Promise<void>((resolve) => { leave = resolve; });
	// What leaving also stops: a player's unanswered connects, and its wait for the host to go.
	const stops = new Set<() => void>();
	const close = (): void => {
		leave();

		for (const stop of stops) {
			stop();
		}

		lobby.close();
	};

	if (await hold(hostLock, released)) {
		const accepted = new Set<string>();
		let onPlayer: (peer: string, link: MakeLink) => void = () => undefined;

		lobby.addEventListener("message", (event: MessageEvent<LobbyMessage>) => {
			const message = event.data;

			if (message.type !== "connect" || !/^player-[1-9]\d*$/u.test(message.peer)) {
				return;
			}

			// A repeat (our answer crossed its retry) is answered again, not linked again.
			if (!accepted.has(message.link)) {
				accepted.add(message.link);
				const signaling = lobbySignaling(lobby, message.link, "host");

				onPlayer(message.peer, (take) => offerLink(linkLabel(match, message.peer), signaling, take));
			}

			lobby.postMessage({ "type": "accepted", "link": message.link } satisfies LobbyMessage);
		});
		remember(peerKey, "player-0");

		return { "role": "host", "match": match, "peer": "player-0", "close": close, "onPlayer": (handler) => { onPlayer = handler; } };
	}

	// A player: the id it had before a reload if that's free, else the lowest free one.
	const want = remembered(peerKey);
	let peer = want !== undefined && /^player-[1-9]\d*$/u.test(want) && await hold(`${prefix}.${want}`, released) ? want : undefined;

	for (let index = 1; peer === undefined; index += 1) {
		if (await hold(`${prefix}.player-${index}`, released)) {
			peer = `player-${index}`;
		}
	}

	remember(peerKey, peer);

	// The host's lock comes free when the host goes: wait for it (and let it straight go — this tab doesn't host).
	let hostLeft = false;
	let onHostLeft = (): void => undefined;

	const waiting = new AbortController();

	stops.add(() => { waiting.abort(); });
	navigator.locks.request(hostLock, { "mode": "shared", "signal": waiting.signal }, () => {
		hostLeft = true;
		onHostLeft();
	}).catch(() => undefined); // aborted: this tab left first

	return {
		"role": "player",
		"match": match,
		"peer": peer,
		"close": close,
		"link": async (take) => {
			const link = crypto.randomUUID();
			// Listening before asking: the host's offer can follow its acceptance straight away.
			const signaling = lobbySignaling(lobby, link, "player");

			await new Promise<void>((resolve) => {
				const send = (): void => { lobby.postMessage({ "type": "connect", "peer": peer, "link": link } satisfies LobbyMessage); };
				const timer = setInterval(send, RETRY_MS);
				const stop = (): void => {
					clearInterval(timer);
					lobby.removeEventListener("message", answered);
					stops.delete(stop);
				};
				const answered = (event: MessageEvent<LobbyMessage>): void => {
					if (event.data.type === "accepted" && event.data.link === link) {
						stop();
						resolve();
					}
				};

				stops.add(stop); // left before the host answered: stop asking (the connect never resolves)

				lobby.addEventListener("message", answered);
				send();
			});

			return answerLink(signaling, take);
		},
		"onHostLeft": (handler) => {
			onHostLeft = handler;

			if (hostLeft) {
				handler();
			}
		}
	};
}
