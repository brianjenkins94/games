/**
 * war2's own MCP tools, served from the host page (observability's page tools; debug-mcp registers them live while the
 * tab is connected) — netsim's (W3, see MIGRATION.md). They reach the referee over the page's trusted link, and each of
 * this tab's clients over its `debug.<peer>.*` subjects — through its instance, in this tab's own tree (the referee's
 * link carries no such calls).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { PageTool } from "@brianjenkins94/observability";
import type { UnitSnapshot } from "../sim/types.ts";
import type { AppliedCommand, Fixture } from "../diag/recorder.ts";
import type { ClientInspection, DiagRequest, RefereeControl, RefereeInspection, UnitInfo } from "./bootstrap.ts";
import { createRpcClient, rpcCallSubject } from "@brianjenkins94/hub";
import { CmdType } from "../sim/command.ts";
import { FP, TILE_PX } from "../sim/components.ts";
import { createComponents, simFields } from "../sim/components.ts";
import { unitRadiusPx, unitTypeId } from "../sim/unitTypes.ts";
import { describe, instanceSubjects, REFEREE_CONTROL, REFEREE_DIAG, REFEREE_INSPECT } from "./bootstrap.ts";

const CALL = { "timeoutMs": 3000, "waitForResponderMs": 1000 };
const FIELDS = simFields(createComponents()).map(([name]) => name);

/** Where a client's view differs from authority's view of its team: unit by unit, field by field. */
export function diffViews(authority: UnitSnapshot[], client: UnitSnapshot[]) {
	const expected = new Map(authority.map((unit) => [unit.uid, unit]));
	const actual = new Map(client.map((unit) => [unit.uid, unit]));
	const differing: { "uid": number; "field": string; "authority": unknown; "client": unknown }[] = [];

	for (const [uid, unit] of expected) {
		const other = actual.get(uid);

		if (other === undefined) {
			continue;
		}

		for (const [index, field] of FIELDS.entries()) {
			if (unit.values[index] !== other.values[index]) {
				differing.push({ "uid": uid, "field": field, "authority": unit.values[index], "client": other.values[index] });
			}
		}

		for (const key of ["orders", "prod", "rally"] as const) {
			if (JSON.stringify(unit[key]) !== JSON.stringify(other[key])) {
				differing.push({ "uid": uid, "field": key, "authority": unit[key], "client": other[key] });
			}
		}
	}

	return { "missing": [...expected.keys()].filter((uid) => !actual.has(uid)), "extra": [...actual.keys()].filter((uid) => !expected.has(uid)), "differing": differing };
}

export function war2Tools(hub: Hub, status: () => unknown): PageTool[] {
	const rpc = createRpcClient(hub);
	const inspectReferee = async () => await rpc.request(REFEREE_INSPECT, undefined, CALL) as RefereeInspection;
	const diag = async <T>(request: DiagRequest) => await rpc.request(REFEREE_DIAG, request, CALL) as T;
	const TILE = TILE_PX * FP;
	const tileOf = (unit: { "x": number; "y": number }): [number, number] => [Math.floor(unit.x / TILE), Math.floor(unit.y / TILE)];
	/** A unit's track as tile segments: each tile, the tick it came, and how long it stayed (to now, for the last). */
	const segments = (track: { "tick": number; "tile": [number, number] }[], now: number) => track.map((entry, index) => ({ "tile": entry.tile, "from": entry.tick, "dwell": (track[index + 1]?.tick ?? now) - entry.tick }));
	/** A client this tab can reach — its own (through its instance); another tab's player is that tab's to inspect. */
	const reachable = async (peer: string): Promise<ClientInspection | undefined> => {
		const subject = instanceSubjects(peer).debug("inspect");

		if (!await hub.whenInterested(rpcCallSubject(subject), CALL.waitForResponderMs)) {
			return undefined;
		}

		return await rpc.request(subject, undefined, CALL) as ClientInspection;
	};
	const ELSEWHERE = "in another tab — its own tab inspects it (the referee's link carries only the game)";
	/** The named client, or every seated one. */
	const peers = async (client: unknown) => typeof client === "string" ? [client] : (await inspectReferee()).seats.map((seat) => seat.peer).sort();
	const clientArg = { "client": { "type": "string", "description": "A client's id (player-0, client-0, …). Omit for every seated client." } };

	return [
		{
			"name": "war2_status",
			"description": "war2's match: the referee's tick, whether it's paused, its speed and stats, and every client's sync state (its view hash checked against the referee's at the tick it's on).",
			"inputSchema": { "type": "object", "properties": {} },
			"handler": async () => {
				const { tick, paused, speed, seats, stats } = await inspectReferee();

				return { "tick": tick, "paused": paused, "speed": speed, "seats": seats, "stats": stats, "clients": (status() as { "clients": unknown }).clients };
			}
		},
		{
			"name": "war2_state",
			"description": `The authoritative world (every unit) and, per client, what it sees and predicts. Positions are fixed-point (${TILE_PX * FP} = one tile).`,
			"inputSchema": { "type": "object", "properties": clientArg },
			"handler": async ({ client }) => {
				const referee = await inspectReferee();
				const clients = await Promise.all((await peers(client)).map(async (peer) => {
					const inspection = await reachable(peer);

					return inspection === undefined ? { "peer": peer, "elsewhere": ELSEWHERE } : { ...inspection, "view": inspection.view.map(describe) };
				}));

				return { "tick": referee.tick, "paused": referee.paused, "units": referee.units, "clients": clients };
			}
		},
		{
			"name": "war2_divergence",
			"description": "Where each client's view differs from what the referee would send its team — missing units, extra units, differing fields. Exact only when the client is at the referee's tick: pause first (war2_control) for a precise diff.",
			"inputSchema": { "type": "object", "properties": clientArg },
			"handler": async ({ client }) => {
				const referee = await inspectReferee();

				return {
					"tick": referee.tick,
					"paused": referee.paused,
					"clients": await Promise.all((await peers(client)).map(async (peer) => {
						const inspection = await reachable(peer);

						if (inspection === undefined) {
							return { "peer": peer, "comparable": false, "reason": ELSEWHERE };
						}

						const base = { "peer": peer, "team": inspection.team, "viewTick": inspection.viewTick, "inSync": inspection.inSync };

						if (inspection.team === undefined || inspection.viewTick !== referee.tick) {
							return { ...base, "comparable": false, "reason": `the client is at tick ${inspection.viewTick}, the referee at ${referee.tick}${referee.paused ? " (it should catch up in a moment)" : " — pause first"}` };
						}

						const divergence = diffViews(referee.views[inspection.team] ?? [], inspection.view);

						return { ...base, "comparable": true, "identical": divergence.missing.length + divergence.extra.length + divergence.differing.length === 0, ...divergence };
					}))
				};
			}
		},
		{
			"name": "war2_control",
			"description": "Pause or resume the referee, step it N ticks (stepping pauses it), or set its speed (a multiplier, 0.25–8). Clients keep predicting while it's paused; their views follow each step.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"action": { "type": "string", "enum": ["pause", "resume", "step", "speed"] },
					"ticks": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "For step: how many ticks (default 1)." },
					"speed": { "type": "number", "minimum": 0.25, "maximum": 8, "description": "For speed: the multiplier." }
				},
				"required": ["action"]
			},
			"handler": async (args) => await rpc.request(REFEREE_CONTROL, args as unknown as RefereeControl, CALL)
		},
		{
			"name": "war2_pathologies",
			"description": "What the referee's pathology detector sees right now: units the pathing has failed — give-up (ordered alone, ended idle away from the target), stuck (grinding toward the settle limit), settled-short (stopped, unbidden, more than a tile from its slot), oscillating (bouncing between two tiles), stalled (moving, but no closer to its target for 5 s — often jittering in place).",
			"inputSchema": { "type": "object", "properties": {} },
			"handler": async () => ({ "tick": (await inspectReferee()).tick, "units": await diag({ "op": "pathologies" }) })
		},
		{
			"name": "war2_unit",
			"description": `One unit, as the referee has it: its state, the fault the detector sees in it (if any), and its recent track (tiles, when it came, how long it stayed). Positions fixed-point (${TILE} = one tile).`,
			"inputSchema": { "type": "object", "properties": { "uid": { "type": "integer", "description": "The unit's stable id." } }, "required": ["uid"] },
			"handler": async ({ uid }) => {
				const referee = await inspectReferee();
				const unit = referee.units.find((candidate) => candidate.uid === uid);
				const faults = await diag<{ "uid": number; "pathology": string }[]>({ "op": "pathologies" });

				if (unit === undefined) {
					return { "tick": referee.tick, "uid": uid, "gone": true };
				}

				return { "tick": referee.tick, ...unit, "tile": tileOf(unit), "pathology": faults.find((fault) => fault.uid === uid)?.pathology, "track": segments(await diag({ "op": "track", "uid": Number(uid) }), referee.tick).slice(-20) };
			}
		},
		{
			"name": "war2_trace",
			"description": "Units' recent trajectories, compressed to tile changes: each tile, the tick it was entered, and the dwell there — a long dwell short of the goal is a stall.",
			"inputSchema": { "type": "object", "properties": { "uids": { "type": "array", "items": { "type": "integer" } } }, "required": ["uids"] },
			"handler": async ({ uids }) => {
				const { tick } = await inspectReferee();

				return { "tick": tick, "units": Object.fromEntries(await Promise.all((uids as number[]).map(async (uid) => [uid, segments(await diag({ "op": "track", "uid": uid }), tick)]))) };
			}
		},
		{
			"name": "war2_region",
			"description": "Units within a box of tiles around (tx, ty), and every pair's clearance: the L1 distance between their centres less their summed collision radii, in pixels (negative is an overlap) — tightest first.",
			"inputSchema": { "type": "object", "properties": { "tx": { "type": "integer" }, "ty": { "type": "integer" }, "r": { "type": "integer", "description": "Box radius in tiles (default 4)." } }, "required": ["tx", "ty"] },
			"handler": async ({ tx, ty, r = 4 }) => {
				const referee = await inspectReferee();
				const inBox = referee.units.filter((unit) => unit.building === undefined && Math.abs(tileOf(unit)[0] - Number(tx)) <= Number(r) && Math.abs(tileOf(unit)[1] - Number(ty)) <= Number(r));
				const radius = (unit: UnitInfo) => unitRadiusPx(unitTypeId(unit.type));
				const pairs = inBox.flatMap((left, index) => inBox.slice(index + 1).map((right) => ({ "pair": [left.uid, right.uid], "clearancePx": Math.round((Math.abs(left.x - right.x) + Math.abs(left.y - right.y)) / FP - radius(left) - radius(right)) })));

				return { "tick": referee.tick, "units": inBox.map((unit) => ({ ...unit, "tile": tileOf(unit) })), "clearances": pairs.sort((left, right) => left.clearancePx - right.clearancePx) };
			}
		},
		{
			"name": "war2_summarize_move",
			"description": "Analyse a MOVE command (the latest, or the one at `tick`): per unit, the tile it started on, where it is now, where it's headed if still moving, how far from the clicked tile it is, its longest dwell since, and its fault if the detector sees one.",
			"inputSchema": { "type": "object", "properties": { "tick": { "type": "integer", "description": "The tick the command was applied at (default: the latest MOVE)." } } },
			"handler": async ({ tick }) => {
				const referee = await inspectReferee();
				const commands = await diag<AppliedCommand[]>({ "op": "commands" });
				const move = commands.filter((entry) => entry.command.type === CmdType.MOVE && (tick === undefined || entry.tick === tick)).at(-1);

				if (move === undefined || move.command.type !== CmdType.MOVE) {
					return { "tick": referee.tick, "found": false, "reason": "no MOVE in the recorder's window (the last ~9 s)" };
				}

				const { unitIds, txFP, tyFP } = move.command;
				const target = tileOf({ "x": txFP, "y": tyFP });
				const faults = await diag<{ "uid": number; "pathology": string }[]>({ "op": "pathologies" });

				return {
					"tick": referee.tick,
					"command": { "tick": move.tick, "team": move.team, "units": unitIds, "target": target, "queue": move.command.queue === true },
					"units": await Promise.all(unitIds.map(async (uid) => {
						const unit = referee.units.find((candidate) => candidate.uid === uid);
						const track = segments(await diag({ "op": "track", "uid": uid }), referee.tick);
						const since = track.filter((entry) => entry.from + entry.dwell >= move.tick);
						const now = unit === undefined ? undefined : tileOf(unit);

						return {
							"uid": uid,
							"start": since[0]?.tile,
							"now": now,
							"heading": unit?.target === undefined ? undefined : tileOf({ "x": unit.target[0], "y": unit.target[1] }),
							"fromTarget": now === undefined ? undefined : Math.max(Math.abs(now[0] - target[0]), Math.abs(now[1] - target[1])),
							"maxDwell": Math.max(0, ...since.map((entry) => entry.dwell)),
							"pathology": faults.find((fault) => fault.uid === uid)?.pathology
						};
					}))
				};
			}
		},
		{
			"name": "war2_incidents",
			"description": "The referee's captured incidents (auto-flagged by the pathology detector, or by war2_flag_incident): id, label, the lead-up tick it replays from, the tick it was flagged, its focus unit. With an id: that incident's commands and every unit at its lead-up.",
			"inputSchema": { "type": "object", "properties": { "id": { "type": "string" } } },
			"handler": async ({ id }) => (id === undefined ? await diag({ "op": "incidents" }) : await diag({ "op": "incident", "id": String(id) }))
		},
		{
			"name": "war2_flag_incident",
			"description": "Capture this moment as an incident: the lead-up snapshot (up to ~9 s back), the commands since, and a hash of the world now — to replay or to save as a test.",
			"inputSchema": { "type": "object", "properties": { "label": { "type": "string", "description": "What looked wrong." } } },
			"handler": async ({ label }) => await diag({ "op": "flag", ...label === undefined ? {} : { "label": String(label) } })
		},
		{
			"name": "war2_replay_incident",
			"description": "Rewind the match to an incident's lead-up, paused: step it (war2_control) and its commands apply again at their ticks — deterministic, so it plays out exactly as it did. Replaces the live match's present.",
			"inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
			"handler": async ({ id }) => await diag({ "op": "replay", "id": String(id) })
		},
		{
			"name": "war2_save_incident_test",
			"description": "An incident as a regression fixture: write the returned `fixture` to `path` (games/war2/test/incidents/<id>.json) and test/incidents.test.ts replays it in CI — asserting the replay reaches the captured world exactly, then its expectation: by default that the focus unit's fault shows again (a known bug, pinned); once fixed, set expect to { reachesGoal: true }. Review it: a give-up at a truly unreachable goal isn't a bug.",
			"inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
			"handler": async ({ id }) => {
				const fixture = await diag<Fixture | undefined>({ "op": "fixture", "id": String(id) });

				if (fixture === undefined) {
					return { "found": false };
				}

				// Incident ids restart every match: the fixture is named for what it caught, and when.
				fixture.id = `${typeof fixture.map === "string" ? fixture.map.split("/").pop()!.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-") : "map"}-${fixture.focus?.pathology ?? "incident"}${fixture.focus === undefined ? "" : `-uid${fixture.focus.uid}`}-t${fixture.flagTick}`;

				return { "path": `games/war2/test/incidents/${fixture.id}.json`, "fixture": fixture };
			}
		},
		{
			"name": "war2_command",
			"description": "Issue a command as a client, exactly as its player would (validated by the client against its prediction, predicted, sent, validated again by the referee). `move` sends `units` toward (x, y) in tiles; `stop` halts them. Answers once the referee has received it (`received`), so a following war2_control step applies it.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"client": { "type": "string", "description": "The client to act as (player-0, client-0, …)." },
					"type": { "type": "string", "enum": ["move", "stop"] },
					"units": { "type": "array", "items": { "type": "integer" }, "description": "Unit ids (its own team's)." },
					"x": { "type": "number", "description": "For move: the target, in tiles." },
					"y": { "type": "number", "description": "For move: the target, in tiles." }
				},
				"required": ["client", "type", "units"]
			},
			"handler": async ({ client, type, units, x, y }) => {
				const peer = String(client);
				const command = type === "move" ? { "type": CmdType.MOVE, "unitIds": units, "txFP": Math.round(Number(x) * TILE_PX * FP), "tyFP": Math.round(Number(y) * TILE_PX * FP) } : { "type": CmdType.STOP, "unitIds": units };
				const taken = async () => (await inspectReferee()).seats.find((seat) => seat.peer === peer)?.lastSeq ?? -1;
				const before = await taken();
				const result = await rpc.request(instanceSubjects(peer).debug("command"), { "command": command }, CALL) as Record<string, unknown>;
				// The client sends it with its next tick; wait for the referee to take the batch in (paused or not).
				const deadline = Date.now() + 2000;
				let received = false;

				while (result["ok"] === true && !received && Date.now() < deadline) {
					received = await taken() > before;

					if (!received) {
						await new Promise((resolve) => { setTimeout(resolve, 20); });
					}
				}

				return { ...result, "received": received };
			}
		}
	];
}
