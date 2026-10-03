/**
 * WebRTC links between the referee and its clients — the one transport every client uses, in this tab or another
 * (netsim's, W3 — see MIGRATION.md). The page that owns each end's worker makes that end's peer connection and hands
 * the data channel straight to the worker (a channel can be transferred as it's created, and there's no
 * RTCPeerConnection in a worker), whose hub links over it (hub's dataChannelTransport). The pages only signal; the
 * game never passes through them.
 *
 * The offer, the answer and the signaling seam are hub's (offerLink, answerLink, localSignaling): in memory within one
 * page, over the match's lobby channel between tabs (lobby.ts). What's war2's is the label, and the seam a lobby hands
 * its host — MakeLink — since PeerJS makes its own connections (peerLobby.ts).
 */
import type { RtcLink } from "@brianjenkins94/hub";

/**
 * How a lobby gives a page one end of a link, however it's made (hub's offer/answer over a signaling path, or
 * PeerJS's own: peerLobby.ts): call it with `take`, and `take` gets the end's data channel in the very task the
 * channel is made or arrives — the only time it can be transferred to a worker.
 */
export type MakeLink = (take: (channel: RTCDataChannel) => void) => RtcLink;

/** The data channel's label for `peer`'s link: both ends name the connection by it (observability does too). */
export function linkLabel(match: string, peer: string): string {
	return `war2.${match}.link.${peer}`;
}
