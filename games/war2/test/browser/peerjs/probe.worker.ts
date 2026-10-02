/**
 * The PeerJS probe's worker: links a hub over the data channel its page handed it, and checks what hub needs of a
 * transport — reliable and ordered — with a stream of sequenced messages and a round trip each way. Posts its report to
 * its page.
 */
import { createHub, createRpcClient, dataChannelTransport, serve } from "@brianjenkins94/hub";

/** How many sequenced messages the dialer sends, each with a little ballast. */
const COUNT = 2000;
const BALLAST = "x".repeat(512);

addEventListener("message", (event: MessageEvent<{ "role": string; "channel": RTCDataChannel }>) => {
	void run(event.data.role, event.data.channel).then((report) => { postMessage(report); }, (error: unknown) => { postMessage({ "error": String(error) }); });
}, { "once": true });

async function run(role: string, channel: RTCDataChannel): Promise<unknown> {
	const hub = createHub({ "id": role });
	const link = hub.link(dataChannelTransport(channel), { "heartbeatMs": 1000 });
	const rpc = createRpcClient(hub);
	const opened = new Promise<void>((resolve) => { channel.addEventListener("open", () => { resolve(); }, { "once": true }); });

	serve(hub, `probe.${role}.ping`, (args) => ({ "pong": args, "from": role }));
	await Promise.all([link.ready, opened]);

	const other = role === "dial" ? "answer" : "dial";
	const pong = await rpc.request(`probe.${other}.ping`, role, { "timeoutMs": 10_000, "waitForResponderMs": 10_000 });

	if (role === "answer") {
		let received = 0;
		let inOrder = true;

		hub.subscribe("probe.seq", (data) => {
			inOrder &&= (data as { "n": number }).n === received;
			received += 1;
		});
		serve(hub, "probe.count", () => ({ "received": received, "inOrder": inOrder }));

		return { "role": role, "ordered": channel.ordered, "maxRetransmits": channel.maxRetransmits, "pong": pong };
	}

	if (!await hub.whenInterested("probe.seq", 10_000)) {
		throw new Error("the answering end never subscribed");
	}

	for (let n = 0; n < COUNT; n += 1) {
		hub.publish("probe.seq", { "n": n, "ballast": BALLAST });
	}

	let count: { "received": number; "inOrder": boolean } = { "received": 0, "inOrder": true };

	for (let tries = 0; tries < 100 && count.received < COUNT; tries += 1) {
		count = await rpc.request("probe.count", undefined, { "timeoutMs": 10_000, "waitForResponderMs": 10_000 }) as typeof count;

		if (count.received < COUNT) {
			await new Promise((resolve) => { setTimeout(resolve, 100); });
		}
	}

	return { "role": role, "ordered": channel.ordered, "maxRetransmits": channel.maxRetransmits, "pong": pong, "sent": COUNT, ...count };
}
