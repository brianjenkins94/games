import type { JoinReply, RefereeTick, StateUpdate } from "../../src/net/index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHub, createRpcClient, serve } from "@brianjenkins94/hub";
import { createClient, createNetwork, hostPermissions, lobbyPermissions, subjects } from "../../src/net/index.ts";
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
	// The referee never even asks it for commands (its link may not send them), so they don't leave it.
	assert.equal(lurker.interested(subjects(MATCH).commands), false);
	lurker.publish(subjects(MATCH).commands, { "seq": 1, "commands": [] });
	match.run(5);
	assert.deepEqual(heard, []);
	assert.deepEqual(denied, [], "nothing for the link to refuse");
	assert.equal(match.referee.stats.unknownSender, 0, "it never reached the referee");
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

	// Its join is seen as rogue's: the reply it gets is rogue's own new seat (its link told it it's rogue, and only
	// rogue's replies reach it) — never the victim's seat or token.
	const rpc = createRpcClient(impostor);
	const reply = await pump(match.network, rpc.request(names.join, {}, { "timeoutMs": 300 })) as JoinReply;

	assert.deepEqual(impostor.knownAs(), ["rogue"]);
	assert.notEqual(reply.team, victim.team());
	assert.notEqual(reply.token, match.replies[0]!.token);
	assert.equal(match.referee.seats().length, 3);
	assert.equal(match.referee.seats().find((seat) => seat.team === reply.team)?.peer, "rogue");

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

test("a client's link to the referee carries none of its observability, either way — its own tab observes it", async () => {
	const match = await startMatch({ "clients": 2 });
	const [first, second] = match.hubs;
	const heard: string[] = [];
	const synced: string[] = [];

	match.refereeHub.subscribe("$sys.>", (_data, envelope) => { heard.push(envelope.subject); });

	for (const hub of [first, second]) {
		hub.subscribe("$sys.arch.sync", () => { synced.push(hub.id); });
	}

	match.network.settle();

	// Seated (seatPermissions) as well as in the lobby: the replies above came from joins.
	for (const hub of [first, second]) {
		hub.publish(`$sys.log.${hub.id}`, {});
		hub.publish(`$sys.arch.${hub.id}`, {});
	}

	match.refereeHub.publish("$sys.arch.sync");
	match.network.settle();
	assert.deepEqual(heard.filter((subject) => subject !== "$sys.arch.sync"), []);
	assert.deepEqual(synced, []);

	match.run(5);

	const [client] = match.clients;
	const [unit] = [...client.view().values()].filter((candidate) => candidate.team === client.team());

	client.command({ "type": "move", "units": [unit.id], "x": tiles(1), "y": tiles(1) });
	match.run(5);
	assert.equal(match.referee.stats.commandsApplied, 1, "and its commands still land");
});

test("a client in another tab plays through a host it confines: neither tab's tree reaches the other's", async () => {
	const match = await startMatch({ "clients": 1 });
	// The remote player's tab: its client hub, and its instance page behind it — linked non-transit on both sides, so
	// the client belongs to both trees while joining neither to the other.
	const hub = createHub({ "id": "remote" });
	const ui = createHub({ "id": "remote/ui" });
	const heard = { "referee": [] as string[], "ui": [] as string[], "client": [] as string[] };

	match.network.link(match.refereeHub, hub, {}, {
		"left": { "peer": "remote", "permissions": lobbyPermissions(MATCH, "remote") },
		"right": { "uplink": true, "transit": false, "permissions": hostPermissions(MATCH, "remote") }
	});
	match.network.link(hub, ui, {}, { "left": { "transit": false } });

	const client = createClient({ "hub": hub, "match": MATCH });

	match.clients.push(client);
	await pump(match.network, client.join());
	match.refereeHub.subscribe("$sys.>", (_data, envelope) => { heard.referee.push(envelope.subject); });
	ui.subscribe("$sys.>", (_data, envelope) => { heard.ui.push(envelope.subject); });
	ui.subscribe(`netsim.${MATCH}.>`, (_data, envelope) => { heard.ui.push(envelope.subject); });
	hub.subscribe("remote.input", (_data, envelope) => { heard.client.push(envelope.subject); });
	match.network.settle();

	// The host's tree tries to reach into the player's tab…
	match.refereeHub.publish("$sys.arch.sync");
	match.refereeHub.publish("remote.input", { "x": 0 });
	// …and the player's tab reports to its own tree.
	hub.publish("$sys.log.remote", {});
	ui.publish("$sys.log.remote/ui", {});
	match.run(5);

	assert.deepEqual(heard.referee.filter((subject) => subject !== "$sys.arch.sync"), [], "the host hears none of the player's observability");
	assert.deepEqual(heard.ui.sort(), ["$sys.log.remote", "$sys.log.remote/ui"], "the player's page hears itself and its client, and nothing of the host's — not even the game");
	assert.deepEqual(heard.client, [], "the host can't send the client its page's input");
	assert.ok(client.inSync() && client.viewTick() === match.referee.world.tick, "while the game itself flows");
});

test("a client confines a hostile host to the game: its state and replies in, the client's game traffic out", () => {
	const network = createNetwork({ "seed": 1 });
	const host = createHub({ "id": "page" });
	const hub = createHub({ "id": "remote" });
	const names = subjects(MATCH);
	const heard = { "host": [] as string[], "client": [] as string[] };
	const allowed = [names.state(0), names.state(3), `$rpc.reply.remote`];
	const refused = [`netsim.${MATCH}.input.remote`, "$sys.arch.sync", "$sys.log.page", `$rpc.call.${names.debug("remote", "inspect")}`, `$rpc.reply.other`];

	// No permissions on the host's side (it listens to everything); the client's own link does the confining.
	network.link(host, hub, {}, { "right": { "uplink": true, "transit": false, "permissions": hostPermissions(MATCH, "remote") } });
	host.subscribe(">", (_data, envelope) => { heard.host.push(envelope.subject); });

	for (const subject of [...allowed, ...refused]) {
		hub.subscribe(subject, (_data, envelope) => { heard.client.push(envelope.subject); });
	}

	network.settle();

	for (const subject of [...allowed, ...refused]) {
		host.publish(subject, {});
	}

	for (const subject of [`$rpc.call.${names.join}`, names.commands, names.diag("remote"), "$sys.log.remote", "$sys.arch.remote", names.diag("other"), "$rpc.reply.page", "remote.view"]) {
		hub.publish(subject, {});
	}

	network.settle();
	assert.deepEqual(heard.client, allowed);
	assert.deepEqual(heard.host.filter((subject) => ![...allowed, ...refused].includes(subject)), [`$rpc.call.${names.join}`, names.commands, names.diag("remote")]);
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

test("nobody can reach a client's debug RPCs across the referee — the page included (a client is debugged in its own tab)", async () => {
	const match = await startMatch({ "clients": 1 });
	const names = subjects(MATCH);
	const [first] = match.hubs;
	const host = createHub({ "id": "host" });

	match.network.link(match.refereeHub, host, {});
	serve(first, names.debug(first.id, "inspect"), () => "reached");
	match.network.settle();
	await assert.rejects(pump(match.network, createRpcClient(host).request(names.debug(first.id, "inspect"), undefined, { "timeoutMs": 300, "waitForResponderMs": 100 })), /timed out|no responder/u);
});

test("a client that rejoins its seat picks up the seat's command sequence, so its commands still land", async () => {
	const match = await startMatch({ "clients": 1 });
	const [leaving] = match.clients;
	const { token } = match.replies[0];
	const own = (client: typeof leaving) => [...client.view().values()].filter((unit) => unit.team === client.team());

	// The first client plays a few moves (batches 1…3), then goes away.
	match.run(2);

	for (const [index, unit] of own(leaving).entries()) {
		leaving.command({ "type": "move", "units": [unit.id], "x": tiles(index + 1), "y": tiles(1) });
		match.run(2);
	}

	assert.equal(match.referee.seats()[0].lastSeq, 3);
	match.unlinks[0]();
	leaving.close();
	match.clients.splice(0, 1);

	// A fresh client (a reloaded page) rejoins with the token and plays: its batches must follow on from the seat's.
	const hub = createHub({ "id": "client-0" });

	match.linkHub(hub);

	const returning = createClient({ "hub": hub, "match": MATCH });

	await pump(match.network, returning.join({ "token": token }));
	match.clients.push(returning);
	match.run(3);

	const [unit] = own(returning);
	const applied = match.referee.stats.commandsApplied;

	returning.command({ "type": "move", "units": [unit.id], "x": tiles(20), "y": tiles(20) });
	match.run(3);
	assert.equal(match.referee.stats.commandsApplied, applied + 1, "the returning client's command was applied");
	assert.equal(match.referee.world.units.get(unit.id).tx, tiles(20));
	assert.equal(match.referee.stats.batchesOutOfOrder, 0);
	assert.ok(isConverged(match, returning));
});
