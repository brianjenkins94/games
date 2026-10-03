/**
 * WebRTC links between the referee and its clients — the one transport every client uses, in this tab or another. The
 * page that owns each end's worker makes that end's peer connection and hands the data channel straight to the worker
 * (a channel can be transferred as it's created, and there's no RTCPeerConnection in a worker), whose hub links over
 * it (hub's dataChannelTransport). The pages only signal; the game never passes through them.
 *
 * The offer, the answer and the signaling seam are hub's (offerLink, answerLink, localSignaling): in memory within one
 * page, over the match's lobby channel between tabs (lobby.ts). Same browser only, for now: host candidates are
 * enough, so no ICE servers (hub's default). What's netsim's is the label.
 */

/** The data channel's label for `peer`'s link: both ends name the connection by it (observability does too). */
export function linkLabel(match: string, peer: string): string {
	return `netsim.${match}.link.${peer}`;
}
