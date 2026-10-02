/**
 * WebRTC links between the referee and its clients — the one transport every client uses, in this tab or another
 * (netsim's, W3 — see MIGRATION.md). The
 * page that owns each end's worker makes that end's peer connection and hands the data channel straight to the worker
 * (a channel can be transferred as it's created, and there's no RTCPeerConnection in a worker), whose hub links over
 * it (hub's dataChannelTransport). The pages only signal; the game never passes through them.
 *
 * Signaling — how the two ends trade their offer, answer and candidates — is a seam: in memory within one page
 * (`localSignaling`), over the match's lobby channel between tabs (lobby.ts). Same browser only, for now: host
 * candidates are enough, so no ICE servers. Across machines it would be a relay or a copy-paste invite.
 */

export type Signal = { "description": RTCSessionDescriptionInit } | { "candidate": RTCIceCandidateInit };

export interface Signaling {
	"send": (signal: Signal) => void;
	/** The other end's signals; any that came before a handler was set go to it then. */
	"onSignal": (handler: (signal: Signal) => void) => void;
}

/** One end's connection: closing it ends the link (both ends' data channels close, and their hubs unlink). */
export interface RtcLink {
	"close": () => void;
}

const CONFIG: RTCConfiguration = { "iceServers": [] };

/** The data channel's label for `peer`'s link: both ends name the connection by it (observability does too). */
export function linkLabel(match: string, peer: string): string {
	return `war2.${match}.link.${peer}`;
}

/** A peer connection that answers `signaling`: a remote description (answering an offer), and candidates — held until
 *  the description they belong to has been set. */
function connect(signaling: Signaling): RTCPeerConnection {
	const connection = new RTCPeerConnection(CONFIG);
	const early: RTCIceCandidateInit[] = [];

	connection.addEventListener("icecandidate", (event) => {
		if (event.candidate !== null) {
			signaling.send({ "candidate": event.candidate.toJSON() });
		}
	});
	signaling.onSignal((signal) => {
		void (async () => {
			if ("description" in signal) {
				await connection.setRemoteDescription(signal.description);

				for (const candidate of early.splice(0)) {
					await connection.addIceCandidate(candidate);
				}

				if (signal.description.type === "offer") {
					await connection.setLocalDescription(await connection.createAnswer());
					signaling.send({ "description": connection.localDescription!.toJSON() });
				}
			} else if (connection.remoteDescription === null) {
				early.push(signal.candidate);
			} else {
				await connection.addIceCandidate(signal.candidate);
			}
		})().catch(() => undefined); // a closed connection: nothing left to signal
	});

	return connection;
}

/** The referee's end: make the connection and its data channel (reliable and ordered: the default), and hand the
 *  channel to `take` at once — before anything's sent on it, the only time it can be transferred to a worker. */
export function offerLink(label: string, signaling: Signaling, take: (channel: RTCDataChannel) => void): RtcLink {
	const connection = connect(signaling);

	take(connection.createDataChannel(label));
	void (async () => {
		await connection.setLocalDescription(await connection.createOffer());
		signaling.send({ "description": connection.localDescription!.toJSON() });
	})().catch(() => undefined);

	return { "close": () => { connection.close(); } };
}

/** A client's end: answer the referee's offer, and hand the data channel to `take` the moment it arrives. */
export function answerLink(signaling: Signaling, take: (channel: RTCDataChannel) => void): RtcLink {
	const connection = connect(signaling);

	connection.addEventListener("datachannel", (event) => { take(event.channel); }, { "once": true });

	return { "close": () => { connection.close(); } };
}

/** Two ends of a signaling path within one page. */
export function localSignaling(): [Signaling, Signaling] {
	const end = () => {
		let handler: ((signal: Signal) => void) | undefined;
		const early: Signal[] = [];

		return {
			"deliver": (signal: Signal): void => {
				if (handler === undefined) {
					early.push(signal);
				} else {
					handler(signal);
				}
			},
			"onSignal": (next: (signal: Signal) => void): void => {
				handler = next;

				for (const signal of early.splice(0)) {
					next(signal);
				}
			}
		};
	};
	const [a, b] = [end(), end()];

	return [
		{ "send": (signal) => { queueMicrotask(() => { b.deliver(signal); }); }, "onSignal": a.onSignal },
		{ "send": (signal) => { queueMicrotask(() => { a.deliver(signal); }); }, "onSignal": b.onSignal }
	];
}
