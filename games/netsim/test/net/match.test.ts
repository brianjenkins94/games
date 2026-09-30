import type { RefereeTick, StateUpdate } from "../../src/net/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHub, createRpcClient } from "@brianjenkins94/hub";
import { createClient, subjects } from "../../src/net/index.ts";
import { decodeUnit, tiles, visibleUnits } from "../../src/sim/index.ts";
import { isConverged, MATCH, pump, randomOrders, startMatch } from "./match.ts";

test("each client gets its own seat, and a full match turns the next one away", async () => {
	const match = await startMatch({ "clients": 3, "config": { "teams": 3 } });

	assert.deepEqual(match.clients.map((client) => client.team()).sort((left, right) => left - right), [0, 1, 2]);

	const extra = match.addClient();

	await assert.rejects(pump(match.network, extra.join()), /full/u);
});

test("on a clean network, every client's view is the referee's view of its team, every tick", async () => {
	const match = await startMatch({ "clients": 4 });
	const orders = randomOrders(match, 1);

	match.run(150, () => {
		orders();

		for (const client of match.clients) {
			assert.ok(isConverged(match, client), `team ${client.team()} at tick ${match.referee.world.tick}`);
		}
	});

	for (const client of match.clients) {
		assert.equal(client.stats.desyncs, 0);
		assert.equal(client.stats.gaps, 0);
		assert.equal(client.stats.stale, 0);
		assert.equal(client.stats.keyframes, 1 + Math.floor((150 - 1) / 10), "a keyframe on the first tick, then every 10");
	}

	assert.ok(match.referee.stats.commandsApplied > 50, `${match.referee.stats.commandsApplied} commands`);
	assert.equal(match.referee.stats.commandsRejected, 0);
});

test("fog: no team is ever sent a unit it can't see, and views change as units come and go", async () => {
	const match = await startMatch({ "clients": 3, "config": { "sight": tiles(4) }, "perTeam": 4 });
	const orders = randomOrders(match, 2, 0.5);
	const names = subjects(MATCH);
	let enemiesSent = 0;
	let removals = 0;

	// A local subscriber on the referee's own hub sees each update as it's published, while the world is at that tick.
	match.refereeHub.subscribe(names.state(0).replace(/\d+$/u, "*"), (data, envelope) => {
		const update = data as StateUpdate;
		const team = Number(envelope.subject.split(".").pop());
		const visible = new Set(visibleUnits(match.referee.world, team).map((unit) => unit.id));

		assert.equal(update.tick, match.referee.world.tick);

		for (const values of update.units) {
			const unit = decodeUnit(values);

			assert.ok(visible.has(unit.id), `team ${team} was sent unit ${unit.id}, which it can't see`);
			enemiesSent += unit.team === team ? 0 : 1;
		}

		removals += update.removed.length;
		assert.ok(update.removed.every((id) => !visible.has(id)));
	});

	match.run(300, orders);
	assert.ok(enemiesSent > 0, "enemies came into view");
	assert.ok(removals > 0, "and left it");
});

test("commands arrive exactly once and in order over a lossy, duplicating, reordering link", async () => {
	const match = await startMatch({ "clients": 2, "faults": [{ "drop": 0.3, "duplicate": 0.3, "jitterMs": 60 }, {}] });
	const [client] = match.clients;

	// Its first keyframe may be one of the dropped frames: play until it has a view.
	for (let round = 0; round < 100 && client.viewTick() < 0; round += 1) {
		match.run(1);
	}

	const [unit] = [...client.view().values()].filter((candidate) => candidate.team === client.team());
	const targets = Array.from({ "length": 40 }, (_, index) => [tiles(1 + (index % 20)), tiles(2 + (index % 7))]);

	for (const [x, y] of targets) {
		client.command({ "type": "move", "units": [unit.id], "x": x, "y": y });
		match.run(1);
	}

	match.run(60);

	const authority = match.referee.world.units.get(unit.id);

	assert.equal(match.referee.stats.commandsApplied, targets.length, "every command applied once");
	assert.deepEqual([authority.tx, authority.ty], targets.at(-1), "the last command is the one in effect");
	assert.ok(match.referee.stats.batchesOutOfOrder > 0, "the link really did duplicate and reorder");
	assert.equal(match.referee.seats().find((seat) => seat.team === client.team())?.lastSeq, targets.length);
});

test("loss, duplication and reordering delay a view but never corrupt it, and it converges once the link heals", async () => {
	const faults = { "drop": 0.25, "duplicate": 0.25, "jitterMs": 80 };
	const match = await startMatch({ "clients": 3, "faults": faults });
	const orders = randomOrders(match, 3, 0.4);

	match.run(200, orders);

	for (const client of match.clients) {
		assert.equal(client.stats.desyncs, 0, `team ${client.team()}: an applied view never disagreed with the referee`);
		assert.ok(client.stats.gaps > 0 && client.stats.stale > 0, `team ${client.team()}: the faults were exercised`);
		assert.ok(client.stats.resyncRequests > 0);
	}

	for (const linkFaults of match.faults) {
		Object.assign(linkFaults, { "drop": 0, "duplicate": 0, "jitterMs": 0 });
	}

	match.run(25);

	for (const client of match.clients) {
		assert.ok(isConverged(match, client), `team ${client.team()} converged after healing`);
	}

	assert.ok(match.referee.stats.resyncs > 0);
});

test("prediction: a command shows on the client at once, and agrees with authority once it lands", async () => {
	const match = await startMatch({ "clients": 2, "faults": { "latencyMs": 120 } });
	const [client] = match.clients;

	match.run(5);

	const [unit] = [...client.view().values()].filter((candidate) => candidate.team === client.team());
	const target = { "x": tiles(12), "y": tiles(12) };
	const startX = unit.x;

	client.command({ "type": "move", "units": [unit.id], ...target });
	client.tick();

	const guess = client.predicted().units.get(unit.id);

	assert.equal(guess.moving, 1, "the prediction moves immediately");
	assert.equal(client.view().get(unit.id).moving, 0, "while the authoritative view hasn't heard yet");
	assert.notEqual(guess.x === startX && guess.y === unit.y, true);

	match.run(250);

	const settled = client.predicted().units.get(unit.id);

	assert.deepEqual([settled.x, settled.y, settled.moving], [target.x, target.y, 0]);
	assert.deepEqual([settled.x, settled.y], [client.view().get(unit.id).x, client.view().get(unit.id).y]);
	assert.equal(client.stats.snaps, 0, "on a clean link the prediction never needed correcting");
});

test("a client only ever receives its own team's view, even subscribing to every team's", async () => {
	const match = await startMatch({ "clients": 3, "config": { "teams": 3 } });
	const [, snoop] = match.clients;
	const subjectsSeen = new Set<string>();
	const denied = new Set<string>();

	match.hubs[1].subscribe("netsim.m.state.*", (_data, envelope) => { subjectsSeen.add(envelope.subject); });
	match.refereeHub.tap((event) => {
		if (event.type === "deny" && event.direction === "subscribe" && event.link.peerId === match.hubs[1].id) {
			denied.add(event.envelope.subject);
		}
	});
	match.network.settle();
	match.run(20);
	assert.deepEqual([...subjectsSeen], [subjects(MATCH).state(snoop.team())]);
	assert.deepEqual([...denied].sort(), [0, 1, 2].filter((team) => team !== snoop.team()).map((team) => subjects(MATCH).state(team)));
	assert.ok(isConverged(match, snoop), "and its own view is unaffected");
});

test("a hub that hasn't joined can neither send commands nor read any state", async () => {
	const match = await startMatch({ "clients": 2 });
	const lurker = createHub({ "id": "lurker" });
	const heard: unknown[] = [];
	const denied: string[] = [];

	match.linkHub(lurker);
	lurker.subscribe("netsim.m.state.>", (data) => { heard.push(data); });
	match.refereeHub.tap((event) => {
		if (event.type === "deny" && event.direction === "publish") {
			denied.push(event.envelope.subject);
		}
	});
	match.network.settle();
	lurker.publish(subjects(MATCH).commands, { "seq": 1, "commands": [] });
	match.run(5);
	assert.deepEqual(heard, []);
	assert.deepEqual(denied, [subjects(MATCH).commands]);
	assert.equal(match.referee.stats.unknownSender, 0, "it never even reached the referee");
});

test("a client can't speak for another: whatever id it claims, it's the one its link was given", async () => {
	const match = await startMatch({ "clients": 2, "config": { "teams": 3 } });
	const [victim] = match.clients;
	const names = subjects(MATCH);
	// A hub that names itself after the victim, linked (and so identified) as "rogue".
	const impostor = createHub({ "id": "client-0" });

	match.linkHub(impostor, {}, "rogue");
	match.network.settle();
	match.run(2);

	// Its join is seen as rogue's (so rogue gets a seat), but the reply goes to the victim's reply subject, which
	// rogue's link may not receive: the impostor never learns the reply.
	const rpc = createRpcClient(impostor);

	await assert.rejects(pump(match.network, rpc.request(names.join, {}, { "timeoutMs": 300 })), /timed out/u);
	assert.equal(match.referee.seats().length, 3);

	// Now seated as rogue, it orders the victim's unit: taken as rogue's command, and refused.
	const [victimUnit] = [...victim.view().values()].filter((unit) => unit.team === victim.team());
	const before = match.referee.world.units.get(victimUnit.id).tx;

	impostor.publish(names.commands, { "seq": 1, "commands": [{ "type": "stop", "units": [victimUnit.id] }] });
	match.run(3);
	assert.equal(match.referee.stats.commandsRejected, 1);
	assert.equal(match.referee.world.units.get(victimUnit.id).tx, before);
	assert.equal(match.referee.seats().find((seat) => seat.team === victim.team())?.lastSeq, 0, "nothing was taken as the victim's");
	assert.ok(isConverged(match, victim));
});

test("a hub can't snoop another client's join reply (and so its token)", async () => {
	const match = await startMatch({ "clients": 1 });
	const snoop = createHub({ "id": "snoop" });
	const snooped: unknown[] = [];

	match.linkHub(snoop);
	snoop.subscribe("$rpc.reply.>", (data) => { snooped.push(data); });
	match.network.settle();

	const late = match.addClient();

	await pump(match.network, late.join());
	assert.deepEqual(snooped, []);
});

test("garbage from a seated client is counted and ignored", async () => {
	const match = await startMatch({ "clients": 2 });
	const names = subjects(MATCH);

	match.run(2);

	const before = match.referee.world.tick;

	for (const garbage of [null, "x", 42, { "seq": "1", "commands": [] }, { "seq": 1 }]) {
		match.hubs[0].publish(names.commands, garbage);
	}

	match.run(2);
	assert.equal(match.referee.stats.malformed, 5);
	assert.equal(match.referee.stats.batchesApplied, 0);
	assert.equal(match.referee.world.tick, before + 2, "and the referee kept ticking");
});

test("a client that drops off and rejoins with its token gets its seat back, and catches up", async () => {
	const match = await startMatch({ "clients": 2 });
	const orders = randomOrders(match, 4);
	const [leaving] = match.clients;
	const { team, token } = match.replies[0];

	match.run(20, orders);
	match.unlinks[0]();
	leaving.close();
	match.clients.splice(0, 1);
	match.run(30, orders);

	const hub = createHub({ "id": "client-returning" });

	match.linkHub(hub);

	const returning = createClient({ "hub": hub, "match": MATCH });
	const reply = await pump(match.network, returning.join({ "token": token }));

	match.clients.push(returning);
	assert.equal(reply.team, team, "the same seat");
	assert.equal(reply.token, token);
	match.run(3, orders);
	assert.ok(isConverged(match, returning), "caught up on the first keyframe");
	assert.equal(match.referee.seats().length, 2, "no new seat was taken");
});

test("a corrupted view is caught by the hash check and repaired by a resync", async () => {
	const match = await startMatch({ "clients": 2 });
	const [client] = match.clients;

	match.run(5);
	assert.ok(isConverged(match, client));

	// Corrupt one unit in the client's view (a bug, or a bad delta): the next update's hash won't match.
	const [unit] = client.view().values();

	assert.equal(client.inSync(), true);
	unit.x += 1;
	match.run(1);
	assert.equal(client.stats.desyncs, 1, "detected on the very next update");
	assert.equal(client.inSync(), false);
	assert.equal(client.stats.resyncRequests, 1);
	match.run(2);
	assert.ok(isConverged(match, client), "and repaired by the keyframe it asked for");
});

test("a prediction that drifts too far from authority is snapped back", async () => {
	const match = await startMatch({ "clients": 2 });
	const [client] = match.clients;

	match.run(3);

	const [id] = [...client.predicted().units.keys()];

	client.predicted().units.get(id).x += tiles(3);
	match.run(1);
	assert.equal(client.stats.snaps, 1);
	assert.equal(client.predicted().units.get(id).x, client.view().get(id).x);
});

test("a closed referee stops seating clients and taking commands", async () => {
	const match = await startMatch({ "clients": 2 });

	match.run(2);
	match.referee.close();

	const late = match.addClient();

	await assert.rejects(pump(match.network, late.join({ "timeoutMs": 200 })), /no responder/u);

	const [client] = match.clients;
	const [unit] = [...client.view().values()].filter((candidate) => candidate.team === client.team());

	client.command({ "type": "stop", "units": [unit.id] });
	match.run(2);
	assert.equal(match.referee.stats.batchesApplied, 0);
});

test("a client can't command before it joins, and ticking before then does nothing", () => {
	const client = createClient({ "hub": createHub(), "match": MATCH });

	assert.throws(() => { client.command({ "type": "stop", "units": [1] }); }, /before join/u);
	client.tick();
	assert.equal(client.stats.batchesSent, 0);
	assert.equal(client.team(), undefined);
	assert.equal(client.viewTick(), -1);
	assert.equal(client.inSync(), false);
});

test("the referee's per-tick summary carries every seated team's view hash, for a host to check clients against", async () => {
	const match = await startMatch({ "clients": 3, "config": { "teams": 3 } });
	const ticks: RefereeTick[] = [];

	match.refereeHub.subscribe(subjects(MATCH).refereeTick, (data) => { ticks.push(data as RefereeTick); });
	match.run(5);
	assert.equal(ticks.length, 5);

	const latest = ticks.at(-1);

	assert.equal(latest.tick, match.referee.world.tick);
	assert.deepEqual(latest.seats.map((seat) => seat.peer).sort((left, right) => left.localeCompare(right)), match.hubs.map((hub) => hub.id).sort((left, right) => left.localeCompare(right)));

	for (const client of match.clients) {
		assert.equal(latest.viewHashes[client.team()], client.viewHash(), `team ${client.team()}`);
	}
});

test("a client may report diagnostics on its own subject only", async () => {
	const match = await startMatch({ "clients": 2 });
	const names = subjects(MATCH);
	const heard: string[] = [];

	match.refereeHub.subscribe(names.diag("*"), (_data, envelope) => { heard.push(envelope.subject); });
	match.network.settle();
	match.hubs[0].publish(names.diag(match.hubs[0].id), { "peer": match.hubs[0].id });
	match.hubs[0].publish(names.diag(match.hubs[1].id), { "peer": match.hubs[1].id });
	match.network.settle();
	assert.deepEqual(heard, [names.diag(match.hubs[0].id)]);
});

test("a client's observability rides its link under its own id only", async () => {
	const match = await startMatch({ "clients": 2 });
	const [first] = match.hubs;
	const heard: string[] = [];
	let synced = 0;

	match.refereeHub.subscribe("$sys.log.>", (_data, envelope) => { heard.push(envelope.subject); });
	match.refereeHub.subscribe("$sys.arch.>", (_data, envelope) => { heard.push(envelope.subject); });
	first.subscribe("$sys.arch.sync", (_data, envelope) => {
		synced += envelope.from === "referee" ? 1 : 0;
	});
	match.network.settle();

	for (const subject of [`$sys.log.${first.id}`, `$sys.log.${first.id}.ui`, `$sys.arch.${first.id}`, `$sys.arch.${first.id}.ui`, "$sys.log.referee", `$sys.log.${match.hubs[1].id}`, "$sys.arch.sync"]) {
		first.publish(subject, {});
	}

	match.refereeHub.publish("$sys.arch.sync");
	match.network.settle();
	// (The referee's own sync request is heard locally too; set it aside.)
	assert.deepEqual(heard.filter((subject) => subject !== "$sys.arch.sync"), [`$sys.log.${first.id}`, `$sys.log.${first.id}.ui`, `$sys.arch.${first.id}`, `$sys.arch.${first.id}.ui`], "its own and its instance page's, never another's");
	assert.equal(synced, 1, "and it hears the viewers' sync requests");
});

test("a client's first keyframe waits for its subscription, so joining never costs a resync", async () => {
	const match = await startMatch({ "clients": 1 });
	const late = match.addClient();

	// Join and tick at once, without letting the new client's state subscription settle first.
	await pump(match.network, late.join());
	match.run(3);
	assert.equal(late.stats.gaps, 0);
	assert.equal(late.stats.resyncRequests, 0);
	assert.equal(late.stats.keyframes, 1);
	assert.ok(isConverged(match, late));
	assert.ok(match.referee.stats.held > 0, "its first update was held until it was listening");
});
