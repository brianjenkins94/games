/**
 * The PeerJS probe's page (W2's first step, see ../../../MIGRATION.md): one end of a PeerJS connection, made exactly as
 * war2's lobby will make it, with the data channel handed to a worker the moment it exists — the only time Chromium
 * lets a channel be transferred. The worker links a hub over it; the page never touches the game traffic.
 *
 *     ?role=dial&id=<mine>&target=<theirs>&broker=<port>   (or role=answer, no target)
 *
 * `&late` makes the dialer wait for PeerJS's `open` before handing the channel over, as the old client did.
 *
 * What happened goes on `window.probe` for the test to read: `registered` once the broker knows this end,
 * `transferred` once the channel is in the worker (or `error`, why not), then the worker's own report.
 */
import { Peer } from "peerjs";

interface Probe { "registered"?: boolean; "transferred"?: boolean; "error"?: string; "report"?: unknown }

const probe: Probe = {};
const params = new URLSearchParams(location.search);
const role = params.get("role");
const worker = new Worker(new URL("probe.worker.ts", import.meta.url), { "type": "module" });

Object.assign(globalThis, { "probe": probe });
worker.addEventListener("message", (event: MessageEvent) => { probe.report = event.data; });

/** Into the worker, now: a channel can only be transferred in the task that created (or delivered) it. */
function hand(channel: RTCDataChannel): void {
	try {
		worker.postMessage({ "role": role, "channel": channel }, [channel as unknown as Transferable]);
		probe.transferred = true;
	} catch (error) {
		probe.error = String(error);
	}
}

// A local broker (the test runs one), and no ICE servers: two ends in one browser need only host candidates.
const peer = new Peer(params.get("id")!, { "host": "localhost", "port": Number(params.get("broker")), "path": "/", "config": { "iceServers": [] } });

peer.on("open", () => { probe.registered = true; });
peer.on("error", (error) => { probe.error ??= `peer: ${error.type}`; });

if (role === "dial") {
	peer.on("open", () => {
		// connect() makes the peer connection and the channel synchronously: reliable is PeerJS for ordered (with no
		// retransmit limit, so reliable too), raw leaves the channel's traffic to us — hub's JSON frames.
		const connection = peer.connect(params.get("target")!, { "reliable": true, "serialization": "raw" });

		if (params.has("late")) {
			connection.on("open", () => { hand(connection.dataChannel); });
		} else {
			hand(connection.dataChannel);
		}
	});
} else {
	// The answering side's connection exists (with its peer connection) when PeerJS announces it; its channel comes
	// with the peer connection's datachannel event, after PeerJS's own handler has wrapped it.
	peer.on("connection", (connection) => {
		connection.peerConnection.addEventListener("datachannel", (event) => { hand(event.channel); }, { "once": true });
	});
}
