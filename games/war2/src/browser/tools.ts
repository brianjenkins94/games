/**
 * war2's own MCP tools, served from the host page (observability's page tools; debug-mcp registers them live while the
 * tab is connected) — netsim's (W3, see MIGRATION.md). They reach the referee over the page's trusted link, and each of
 * this tab's clients over its `debug.<peer>.*` subjects — through its instance, in this tab's own tree (the referee's
 * link carries no such calls).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { PageTool } from "@brianjenkins94/observability";
import type { UnitSnapshot } from "../sim/types.ts";
import type { ClientInspection, RefereeControl, RefereeInspection } from "./bootstrap.ts";
import { createRpcClient, rpcCallSubject } from "@brianjenkins94/hub";
import { CmdType } from "../sim/command.ts";
import { FP, TILE_PX } from "../sim/components.ts";
import { createComponents, simFields } from "../sim/components.ts";
import { describe, instanceSubjects, REFEREE_CONTROL, REFEREE_INSPECT } from "./bootstrap.ts";

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
