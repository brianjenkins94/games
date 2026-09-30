/**
 * netsim's own MCP tools, served from the page (observability's page tools; debug-mcp registers them live while the
 * tab is connected). They reach the referee over the page's trusted link and each client over its `debug.<peer>.*`
 * subjects, which the referee's hub lets only the page call (debugPermissions).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { PageTool } from "@brianjenkins94/observability";
import type { ClientInspection, RefereeControl, RefereeInspection } from "./bootstrap.ts";
import { createRpcClient } from "@brianjenkins94/hub";
import { diffUnits, isEmpty, subjects } from "../net/index.ts";
import { decodeUnit, FP } from "../sim/index.ts";
import { MATCH, REFEREE_CONTROL, REFEREE_INSPECT } from "./bootstrap.ts";

const CALL = { "timeoutMs": 3000, "waitForResponderMs": 1000 };

export function netsimTools(hub: Hub, status: () => unknown): PageTool[] {
	const rpc = createRpcClient(hub);
	const names = subjects(MATCH);
	const inspectReferee = async () => await rpc.request(REFEREE_INSPECT, undefined, CALL) as RefereeInspection;
	const inspectClient = async (peer: string) => await rpc.request(names.debug(peer, "inspect"), undefined, CALL) as ClientInspection;
	/** The named client, or every seated one. */
	const peers = async (client: unknown) => typeof client === "string" ? [client] : (await inspectReferee()).seats.map((seat) => seat.peer).sort();
	const clientArg = { "client": { "type": "string", "description": "A client's id (client-0, client-1, …). Omit for every seated client." } };

	return [
		{
			"name": "netsim_status",
			"description": "netsim's match: the referee's tick, whether it's paused, its stats, and every client's sync state (its view hash checked against the referee's at the tick it's on).",
			"inputSchema": { "type": "object", "properties": {} },
			"handler": async () => {
				const { tick, paused, seats, stats } = await inspectReferee();

				return { "tick": tick, "paused": paused, "seats": seats, "stats": stats, "clients": (status() as { "clients": unknown }).clients };
			}
		},
		{
			"name": "netsim_state",
			"description": `The authoritative world (every unit) and, per client, what it sees and predicts. Units are objects; positions are fixed-point (${FP} = one tile).`,
			"inputSchema": { "type": "object", "properties": clientArg },
			"handler": async ({ client }) => {
				const referee = await inspectReferee();
				const clients = await Promise.all((await peers(client)).map(async (peer) => {
					const inspection = await inspectClient(peer);

					return { ...inspection, "units": inspection.units.map(decodeUnit), "predicted": inspection.predicted.map(decodeUnit) };
				}));

				return { "tick": referee.tick, "paused": referee.paused, "units": referee.units.map(decodeUnit), "clients": clients };
			}
		},
		{
			"name": "netsim_divergence",
			"description": "Where each client's view differs from what the referee says its team can see — missing units, extra units, and differing fields. Exact only when the client is at the referee's tick: pause first (netsim_control) for a precise diff.",
			"inputSchema": { "type": "object", "properties": clientArg },
			"handler": async ({ client }) => {
				const referee = await inspectReferee();

				return {
					"tick": referee.tick,
					"paused": referee.paused,
					"clients": await Promise.all((await peers(client)).map(async (peer) => {
						const inspection = await inspectClient(peer);
						const base = { "peer": peer, "team": inspection.team, "viewTick": inspection.viewTick, "inSync": inspection.inSync };

						if (inspection.team === undefined || inspection.viewTick !== referee.tick) {
							return { ...base, "comparable": false, "reason": `the client is at tick ${inspection.viewTick}, the referee at ${referee.tick}${referee.paused ? " (it should catch up in a moment)" : " — pause first"}` };
						}

						const divergence = diffUnits((referee.visible[inspection.team] ?? []).map(decodeUnit), inspection.units.map(decodeUnit));

						return { ...base, "comparable": true, "identical": isEmpty(divergence), ...divergence };
					}))
				};
			}
		},
		{
			"name": "netsim_control",
			"description": "Pause or resume the referee, or step it N ticks (stepping pauses it). Clients keep predicting while it's paused; their views follow each step.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"action": { "type": "string", "enum": ["pause", "resume", "step"] },
					"ticks": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "For step: how many ticks (default 1)." }
				},
				"required": ["action"]
			},
			"handler": async (args) => await rpc.request(REFEREE_CONTROL, args as unknown as RefereeControl, CALL)
		},
		{
			"name": "netsim_command",
			"description": "Issue a command as a client, exactly as its player would (it's predicted locally, sent, validated by the referee). `move` sends `units` toward (x, y) in tiles; `stop` halts them.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"client": { "type": "string", "description": "The client to act as (client-0, …)." },
					"type": { "type": "string", "enum": ["move", "stop"] },
					"units": { "type": "array", "items": { "type": "integer" }, "description": "Unit ids (its own team's)." },
					"x": { "type": "number", "description": "For move: the target, in tiles." },
					"y": { "type": "number", "description": "For move: the target, in tiles." }
				},
				"required": ["client", "type", "units"]
			},
			"handler": async ({ client, type, units, x, y }) => {
				const command = type === "move" ? { "type": type, "units": units, "x": Math.round(Number(x) * FP), "y": Math.round(Number(y) * FP) } : { "type": type, "units": units };

				return await rpc.request(names.debug(String(client), "command"), { "command": command }, CALL);
			}
		}
	];
}
