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

export interface Transport {
    send(data: ArrayBuffer): void;
    onData: ((data: ArrayBuffer) => void) | null;
    peerId: string;
}

function wrapConn(conn: DataConnection): Transport {
    const t: Transport = { peerId: conn.peer, onData: null, send };

    conn.on("data", (raw) => {
        // PeerJS with serialization:"raw" delivers ArrayBuffer
        if (t.onData && raw instanceof ArrayBuffer) t.onData(raw);
    });

    function send(data: ArrayBuffer): void {
        conn.send(data);
    }

    return t;
}

/** Open a Peer, wait for the signaling server to assign an ID. */
export function openPeer(): Promise<{ peer: Peer; selfId: string }> {
    return new Promise((resolve, reject) => {
        const peer = PEER_SERVER ? new Peer(PEER_SERVER as never) : new Peer();
        peer.once("open",  (id) => resolve({ peer, selfId: id }));
        peer.once("error", reject);
    });
}

/** Host side: initiate connection to peer B. */
export function connectTo(peer: Peer, targetId: string): Promise<Transport> {
    return new Promise((resolve, reject) => {
        const conn = peer.connect(targetId, { reliable: false, serialization: "raw" });
        conn.once("open",  () => resolve(wrapConn(conn)));
        conn.once("error", reject);
    });
}

/** Peer side: wait for an incoming connection. */
export function waitForConnection(peer: Peer): Promise<Transport> {
    return new Promise((resolve) => {
        peer.once("connection", (conn: DataConnection) => {
            conn.once("open", () => resolve(wrapConn(conn)));
        });
    });
}
