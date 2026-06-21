/**
 * PeerJS transport wrapper.
 *
 * - Each client creates a Peer connected to the local signaling server (port 9000).
 * - Host calls connect(targetId); peer waits for an incoming connection.
 * - All game packets are sent as raw ArrayBuffer over a reliable=false data channel
 *   (mimics UDP semantics; PeerJS/WebRTC still delivers them in-order within a stream).
 */
import Peer, { type DataConnection } from "peerjs";

// Determined at runtime by hostname rather than the build-time DEV flag, so the
// same built bundle behaves correctly wherever it's loaded: on GitHub Pages it
// uses the public PeerJS cloud broker; anywhere else (local dev) it uses the
// local broker that `npm run dev` starts (`peer --port 9000`).
const IS_DEPLOYED = location.hostname === "brianjenkins94.github.io";
const PEER_SERVER = IS_DEPLOYED ? undefined : { host: "localhost", port: 9000, path: "/" };

// PeerJS handles signaling + connection setup only.  Game packets ride the raw
// RTCDataChannel (conn.dataChannel) on both peers — either operated directly on
// the main thread (relay fallback) or transferred into the sim worker — so the
// wire bytes are identical regardless of which path each side takes.

/** Open a Peer, wait for the signaling server to assign an ID. */
export function openPeer(): Promise<{ peer: Peer; selfId: string }> {
    return new Promise((resolve, reject) => {
        const peer = PEER_SERVER ? new Peer(PEER_SERVER as never) : new Peer();
        peer.once("open",  (id) => resolve({ peer, selfId: id }));
        peer.once("error", reject);
    });
}

/** Host side: initiate connection to peer B. Resolves the open DataConnection. */
export function connectTo(peer: Peer, targetId: string): Promise<DataConnection> {
    return new Promise((resolve, reject) => {
        const conn = peer.connect(targetId, { reliable: false, serialization: "raw" });
        conn.once("open",  () => resolve(conn));
        conn.once("error", reject);
    });
}
