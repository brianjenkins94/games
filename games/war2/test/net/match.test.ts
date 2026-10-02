/**
 * war2's net layer (W2): netsim's match tests, with war2's sim — a referee and its clients, every client predicting
 * on a world of its own, all in this one process over a virtual network with fault injection.
 */
import type { JoinReply, RefereeTick, StateUpdate } from "../../src/net/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHub, createRpcClient } from "@brianjenkins94/hub";
import { createClient, PUBLIC_FIELDS, subjects } from "../../src/net/index.ts";
import { CmdType } from "../../src/sim/command.ts";
import { tileCenterFP, TILE_PX, FP } from "../../src/sim/components.ts";
import { computeVisibleUids } from "../../src/sim/vision.ts";
import { eidForUnitId } from "../../src/sim/world.ts";
import { field, isConverged, loadMap, MATCH, ownUnits, pump, randomOrders, startMatch } from "./match.ts";

test("each client gets its own seat, and a full match turns the next one away", async () => {
	const match = await startMatch({ "clients": 3 });

	assert.deepEqual(match.clients.map((client) => client.team()).sort((left, right) => left - right), [0, 1, 2]);

	const extra = match.addClient();

	await assert.rejects(pump(match.network, extra.join()), /full/u);
});

test("on a clean network, every client's view is the referee's view of its team, every tick", async () => {
	const match = await startMatch({ "clients": 3 });
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

test("fog: no team is sent a unit it can't see, nor more of an enemy than it shows, and views change as units come and go", async () => {
	const match = await startMatch({ "clients": 2, "perTeam": 4 });
	const orders = randomOrders(match, 2, 0.5);
	const { world } = match.referee;
	const names = subjects(MATCH);
	let enemiesSent = 0;
	let removals = 0;

	// A local subscriber on the referee's own hub sees each update as it's published, while the world is at that tick.
	match.refereeHub.subscribe(`war2.${MATCH}.state.*`, (data, envelope) => {
		const update = data as StateUpdate;
		const team = Number(envelope.subject.split(".").pop());
		const visible = computeVisibleUids(world, team);

		assert.equal(update.tick, world.tick);

		for (const unit of update.units) {
			assert.ok(visible.has(unit.uid), `team ${team} was sent unit ${unit.uid}, which it can't see`);

			if (field(world, unit, "Unit.team") !== team) {
				enemiesSent += 1;
				assert.deepEqual(world.fields.flatMap(([name], index) => (PUBLIC_FIELDS.has(name) || unit.values[index] === 0 ? [] : [name])), [], "nothing private of an enemy");
				assert.equal(unit.orders, undefined);
			}
		}

		removals += update.removed.length;
		assert.ok(update.removed.every((uid) => !visible.has(uid)));
	});
	assert.equal(names.state(0), `war2.${MATCH}.state.0`);

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

	const [unit] = ownUnits(match, client);
	const targets = Array.from({ "length": 40 }, (_, index) => [1 + (index % 20), 2 + (index % 7)]);

	for (const [x, y] of targets) {
		client.command({ "type": CmdType.MOVE, "unitIds": [unit.uid], "txFP": tileCenterFP(x), "tyFP": tileCenterFP(y) });
		match.run(1);
	}

	match.run(60);

	const last = match.referee.world.lastMove[client.team()];

	assert.equal(match.referee.stats.commandsApplied, targets.length, "every command applied once");
	assert.deepEqual([last.tileX, last.tileY], targets.at(-1), "the last command is the one in effect");
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

	const [unit] = ownUnits(match, client);
	const { world } = match.referee;
	const target = tileCenterFP(12);
	const predicted = client.predicted();
	const { MoveTarget, Position } = predicted.components;
	const eid = eidForUnitId(predicted, unit.uid);

	client.command({ "type": CmdType.MOVE, "unitIds": [unit.uid], "txFP": target, "tyFP": target });
	client.tick();

	assert.equal(MoveTarget.active[eid], 1, "the prediction moves immediately");
	assert.equal(field(world, client.view().get(unit.uid), "MoveTarget.active"), 0, "while the authoritative view hasn't heard yet");
	assert.notDeepEqual([Position.x[eid], Position.y[eid]], [field(world, unit, "Position.x"), field(world, unit, "Position.y")]);

	match.run(250);

	const authority = client.view().get(unit.uid);

	assert.equal(MoveTarget.active[eid], 0, "settled");
	assert.deepEqual([Position.x[eid], Position.y[eid]], [field(world, authority, "Position.x"), field(world, authority, "Position.y")], "where authority settled it");
	assert.equal(client.stats.snaps, 0, "on a clean link the prediction never needed correcting");
});

test("a client only ever receives its own team's view, even subscribing to every team's", async () => {
	const match = await startMatch({ "clients": 3 });
	const [, snoop] = match.clients;
	const subjectsSeen = new Set<string>();
	const denied = new Set<string>();

	match.hubs[1].subscribe(`war2.${MATCH}.state.*`, (_data, envelope) => { subjectsSeen.add(envelope.subject); });
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

	match.linkHub(lurker);
	lurker.subscribe(`war2.${MATCH}.state.>`, (data) => { heard.push(data); });
	match.network.settle();
	assert.equal(lurker.interested(subjects(MATCH).commands), false);
	lurker.publish(subjects(MATCH).commands, { "seq": 1, "commands": [] });
	match.run(5);
	assert.deepEqual(heard, []);
	assert.equal(match.referee.stats.unknownSender, 0, "it never reached the referee");
});

test("a client can't speak for another: whatever id it claims, it's the one its link was given, and its orders are its own", async () => {
	const match = await startMatch({ "clients": 2, "teams": 3 });
	const [victim] = match.clients;
	const names = subjects(MATCH);
	// A hub that names itself after the victim, linked (and so identified) as "rogue".
	const impostor = createHub({ "id": "client-0" });

	match.linkHub(impostor, {}, "rogue");
	match.network.settle();
	match.run(2);

	const rpc = createRpcClient(impostor);
	const reply = await pump(match.network, rpc.request(names.join, {}, { "timeoutMs": 300 })) as JoinReply;

	assert.deepEqual(impostor.knownAs(), ["rogue"]);
	assert.notEqual(reply.team, victim.team());
	assert.notEqual(reply.token, match.replies[0]!.token);
	assert.equal(match.referee.seats().find((seat) => seat.team === reply.team)?.peer, "rogue");

	// Now seated as rogue, it stops the victim's unit: taken as rogue's command, and refused (validate.ts: not-owner).
	const [victimUnit] = ownUnits(match, victim);

	impostor.publish(names.commands, { "seq": 1, "commands": [{ "type": CmdType.STOP, "unitIds": [victimUnit.uid] }] });
	match.run(3);
	assert.equal(match.referee.stats.commandsRejected, 1);
	assert.equal(match.referee.seats().find((seat) => seat.team === victim.team())?.lastSeq, 0, "nothing was taken as the victim's");
	assert.ok(isConverged(match, victim));
});

test("garbage from a seated client is counted and ignored; bad commands in a good batch are refused one by one", async () => {
	const match = await startMatch({ "clients": 2 });
	const names = subjects(MATCH);
	const [client] = match.clients;

	match.run(2);

	const before = match.referee.world.tick;

	for (const garbage of [null, "x", 42, { "seq": "1", "commands": [] }, { "seq": 1 }]) {
		match.hubs[0].publish(names.commands, garbage);
	}

	match.run(2);
	assert.equal(match.referee.stats.malformed, 5);
	assert.equal(match.referee.stats.batchesApplied, 0);
	assert.equal(match.referee.world.tick, before + 2, "and the referee kept ticking");

	const [unit] = ownUnits(match, client);

	match.hubs[0].publish(names.commands, { "seq": 1, "commands": [{ "type": CmdType.SPAWN, "xFP": 0, "yFP": 0, "team": 0, "typeId": 1 }, { "type": CmdType.MOVE, "unitIds": [unit.uid], "txFP": Number.NaN, "tyFP": 0 }, { "type": CmdType.STOP, "unitIds": [unit.uid] }] });
	match.run(2);
	assert.equal(match.referee.stats.commandsRejected, 2);
	assert.equal(match.referee.stats.commandsApplied, 1);
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

	const returning = createClient({ "hub": hub, "match": MATCH, "loadMap": loadMap });
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
	unit.values[0] += 1;
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

	const [unit] = ownUnits(match, client);
	const predicted = client.predicted();
	const eid = eidForUnitId(predicted, unit.uid);

	predicted.components.Position.x[eid] += 3 * TILE_PX * FP;
	match.run(1);
	assert.equal(client.stats.snaps, 1);
	assert.equal(predicted.components.Position.x[eid], field(match.referee.world, client.view().get(unit.uid), "Position.x"));
});

test("a closed referee stops seating clients and taking commands", async () => {
	const match = await startMatch({ "clients": 2 });

	match.run(2);
	match.referee.close();

	const late = match.addClient();

	await assert.rejects(pump(match.network, late.join({ "timeoutMs": 200 })), /no responder/u);

	const [client] = match.clients;
	const [unit] = ownUnits(match, client);

	client.command({ "type": CmdType.STOP, "unitIds": [unit.uid] });
	match.run(2);
	assert.equal(match.referee.stats.batchesApplied, 0);
});

test("a client can't command before it joins, and ticking before then does nothing", () => {
	const client = createClient({ "hub": createHub(), "match": MATCH, "loadMap": loadMap });

	assert.throws(() => { client.command({ "type": CmdType.STOP, "unitIds": [1] }); }, /before join/u);
	client.tick();
	assert.equal(client.stats.batchesSent, 0);
	assert.equal(client.team(), undefined);
	assert.equal(client.viewTick(), -1);
	assert.equal(client.inSync(), false);
});

test("the referee's per-tick summary carries every seated team's view hash, for a host to check clients against", async () => {
	const match = await startMatch({ "clients": 3 });
	const ticks: RefereeTick[] = [];

	match.refereeHub.subscribe(subjects(MATCH).refereeTick, (data) => { ticks.push(data as RefereeTick); });
	match.run(5);
	assert.equal(ticks.length, 5);

	const latest = ticks.at(-1);

	assert.equal(latest.tick, match.referee.world.tick);

	for (const client of match.clients) {
		assert.equal(latest.viewHashes[client.team()], client.viewHash(), `team ${client.team()}`);
	}
});

test("a client that joins while the match is paused gets its view anyway — sync sends keyframes without a tick", async () => {
	const match = await startMatch({ "clients": 1 });

	match.run(3);

	const late = match.addClient();

	await pump(match.network, late.join());
	match.network.settle();
	match.referee.sync();
	match.network.settle();
	assert.equal(late.viewTick(), match.referee.world.tick);
	assert.ok(isConverged(match, late));
});
