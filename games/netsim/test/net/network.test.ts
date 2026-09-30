import assert from "node:assert/strict";
import { test } from "node:test";
import { createHub } from "@brianjenkins94/hub";
import { createNetwork } from "../../src/net/index.ts";

function linked(faults = {}, seed = 1) {
	const network = createNetwork({ "seed": seed });
	const left = createHub({ "id": "left" });
	const right = createHub({ "id": "right" });
	const received: unknown[] = [];

	right.subscribe("netsim.m.state.0", (data) => { received.push(data); });
	right.subscribe("other", (data) => { received.push(data); });
	network.link(left, right, faults);
	network.settle();

	return { "network": network, "left": left, "right": right, "received": received };
}

test("nothing arrives until the clock reaches the link's latency", () => {
	const { network, left, received } = linked({ "latencyMs": 30 });

	left.publish("other", 1);
	network.advance(29);
	assert.deepEqual(received, []);
	network.advance(1);
	assert.deepEqual(received, [1]);
});

test("without jitter, frames arrive in the order they were sent", () => {
	const { network, left, received } = linked();

	for (let index = 0; index < 20; index += 1) {
		left.publish("netsim.m.state.0", index);
	}

	network.settle();
	assert.deepEqual(received, Array.from({ "length": 20 }, (_, index) => index));
});

test("jitter reorders game frames; the same seed reorders them the same way", () => {
	const order = (seed: number) => {
		const { network, left, received } = linked({ "jitterMs": 40 }, seed);

		for (let index = 0; index < 30; index += 1) {
			left.publish("netsim.m.state.0", index);
		}

		network.settle();

		return received;
	};

	assert.notDeepEqual(order(3), Array.from({ "length": 30 }, (_, index) => index));
	assert.deepEqual(order(3), order(3));
	assert.equal(order(3).length, 30);
});

test("drops and duplicates hit game traffic only, deterministically", () => {
	const { network, left, received } = linked({ "drop": 0.3, "duplicate": 0.2 }, 5);

	for (let index = 0; index < 200; index += 1) {
		left.publish("netsim.m.state.0", index);
		left.publish("other", -1);
	}

	network.settle();

	const game = received.filter((value) => value !== -1);

	assert.equal(received.filter((value) => value === -1).length, 200, "non-game traffic is never dropped or duplicated");
	assert.ok(network.stats.dropped > 30 && network.stats.dropped < 90, `dropped ${network.stats.dropped}`);
	assert.ok(network.stats.duplicated > 10, `duplicated ${network.stats.duplicated}`);
	assert.equal(game.length, 200 - network.stats.dropped + network.stats.duplicated);
});

test("hub control frames get through a link that drops every game frame", () => {
	// Interest (sub/unsub/hello) must survive, or a hub would never learn what its peer wants.
	const { network, left, received } = linked({ "drop": 1 });

	left.publish("netsim.m.state.0", "lost");
	left.publish("other", "kept");
	network.settle();
	assert.deepEqual(received, ["kept"]);
	assert.ok(left.interested("netsim.m.state.0"), "the subscription still propagated");
});

test("unlinking stops delivery, including frames already in flight", () => {
	const network = createNetwork();
	const left = createHub();
	const right = createHub();
	const received: unknown[] = [];

	right.subscribe("other", (data) => { received.push(data); });

	const unlink = network.link(left, right);

	network.settle();
	left.publish("other", 1);
	unlink();
	network.settle();
	assert.deepEqual(received, []);
	assert.equal(network.now() > 0, true);
});
