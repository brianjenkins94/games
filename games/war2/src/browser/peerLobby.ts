/**
 * A tab's way into a match with players on other machines (W3, see MIGRATION.md): PeerJS — its broker to find each
 * other, its STUN and TURN servers to get through NATs — where hub's joinLobby is for tabs of one browser.
 *
 * - **Who hosts:** whoever registers the match's PeerJS id (`war2-<match>`) with the broker first. A tab that finds it
 *   taken is a player, and dials it. (A reloaded host's id can still be held for a while: the match ends with its host,
 *   as in netsim — see "Host restore" in MIGRATION.md.)
 * - **Who's who:** a player names itself (`player-<6 hex>`, kept across a reload of its tab), in its connection's
 *   metadata. A name that links again (its tab reloaded) replaces its old link, as a relinked instance does — but a name
 *   proves nothing: its seat goes only to a link that presents the seat's token (net/referee.ts), and the host's own
 *   `player-0` is never a player's name.
 * - **The links:** PeerJS makes each peer connection and its data channel — reliable and ordered, raw (hub's frames)
 *   — and the channel goes to the worker the moment it exists: the dialing side's straight from `connect()`, the host's
 *   from the peer connection's `datachannel` event (test/browser/peerjs.test.ts pins both). PeerJS's own events stop on
 *   the page once the channel moves; whether the host is still there is read off the peer connection itself.
 *
 * `options.broker` points at a broker of our own (`host:port`; a test runs one) and `options.iceServers` overrides
 * PeerJS's (none, for two ends on one machine); by default it's PeerJS's cloud broker and its default ICE servers —
 * free and shared, for playtesting.
 */
import type { DataConnection, PeerOptions } from "peerjs";
import type { Lobby } from "@brianjenkins94/hub";
import { Peer } from "peerjs";

export interface PeerLobbyOptions {
	/** A broker of our own, as `host:port` (plain ws on localhost, wss elsewhere). Default: PeerJS's cloud. */
	"broker"?: string;
	/** ICE servers in place of PeerJS's defaults (Google STUN, PeerJS TURN). */
	"iceServers"?: RTCIceServer[];
}

/** A player's name, as a player makes it: `player-` and six hex digits — never the host's own `player-0`. */
const NAME = /^player-[\da-f]{6}$/u;

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
	} catch { /* no storage: a reload joins under a new name */ }
}

function peerOptions({ broker, iceServers }: PeerLobbyOptions): PeerOptions {
	const options: PeerOptions = {};

	if (broker !== undefined) {
		const [host, port] = broker.split(":");

		Object.assign(options, { "host": host, "port": Number(port ?? 443), "path": "/", "secure": host !== "localhost" && host !== "127.0.0.1" });
	}

	if (iceServers !== undefined) {
		options.config = { "iceServers": iceServers };
	}

	return options;
}

/** A peer registered with the broker as `id` (or a random one): resolves once it's registered, rejects with PeerJS's
 *  error type (`unavailable-id`: someone has it). */
async function register(id: string | undefined, options: PeerOptions): Promise<Peer> {
	return new Promise((resolve, reject) => {
		const peer = id === undefined ? new Peer(options) : new Peer(id, options);
		const failed = (error: { "type": string }): void => {
			peer.destroy();
			reject(new Error(error.type));
		};

		peer.once("error", failed);
		peer.once("open", () => {
			peer.off("error", failed);
			resolve(peer);
		});
	});
}

/** Join match `match` through PeerJS: this tab hosts it if nobody has registered it yet, else joins it as a player. */
export async function joinPeerLobby(match: string, lobbyOptions: PeerLobbyOptions = {}): Promise<Lobby> {
	const hostId = `war2-${match}`;
	const options = peerOptions(lobbyOptions);
	const hosting = await register(hostId, options).catch((error: unknown) => {
		if ((error as Error).message === "unavailable-id") {
			return undefined;
		}

		throw error;
	});

	if (hosting !== undefined) {
		/** Each linked player's connection, by name. */
		const linked = new Map<string, DataConnection>();
		let onPlayer: Parameters<Extract<Lobby, { "role": "host" }>["onPlayer"]>[0] | undefined;

		hosting.on("connection", (connection) => {
			const name = (connection.metadata as { "name"?: unknown } | undefined)?.name;

			// Not a player's name, or nobody listening yet: refused.
			if (typeof name !== "string" || !NAME.test(name) || onPlayer === undefined) {
				connection.close();

				return;
			}

			linked.get(name)?.close();
			linked.set(name, connection);
			// Now, in this task: the referee's end has to be listening for the channel before the offer is answered.
			onPlayer(name, (take) => {
				connection.peerConnection.addEventListener("datachannel", (event) => { take(event.channel); }, { "once": true });

				return { "close": () => { connection.close(); } };
			});
		});

		return { "role": "host", "peer": "player-0", "onPlayer": (handler) => { onPlayer = handler; } };
	}

	const key = `war2.${match}.name`;
	const name = remembered(key) ?? `player-${crypto.randomUUID().slice(0, 6)}`;
	const peer = await register(undefined, options);
	let onHostLeft = (): void => undefined;
	let hostLeft = false;

	remember(key, name);

	return {
		"role": "player",
		"peer": name,
		"link": async (take) => {
			const connection = peer.connect(hostId, { "reliable": true, "serialization": "raw", "metadata": { "name": name } });
			const pc = connection.peerConnection;
			let closing = false;

			// Straight to the worker: connect() made the channel just now, in this task.
			take(connection.dataChannel);
			// Its connection going without our closing it: the host went.
			pc.addEventListener("connectionstatechange", () => {
				if (!closing && !hostLeft && ["disconnected", "failed", "closed"].includes(pc.connectionState)) {
					hostLeft = true;
					onHostLeft();
				}
			});

			return {
				"close": () => {
					closing = true;
					connection.close();
				}
			};
		},
		"onHostLeft": (handler) => {
			onHostLeft = handler;

			if (hostLeft) {
				handler();
			}
		}
	};
}
