/**
 * The referee's flight recorder (W4, see MIGRATION.md): what happened lately, kept small enough to keep always, and
 * pulled by the host's tools rather than pushed every tick (the old debug server kept the whole ECS, every tick,
 * forever). Watching the referee's world after each step (RefereeOptions.observe), it keeps:
 *
 * - **snapshots** every `snapEvery` ticks, the last `keep` — the lead-up an incident replays from;
 * - **the commands applied** over the last 30 s, each with its tick and its issuer's team;
 * - **each unit's track**: the tick it entered each tile (its last `trackLength`) — for a trajectory;
 * - **the pathology detector** (pathology.ts), run every tick, and what it finds now;
 * - **incidents**: a moment captured for replay — its lead-up snapshot, the commands since, and a hash of the world at
 *   the moment. Flagged by hand, or automatically when the detector sees a give-up, a settle short, a stall, or a stuck
 *   unit that stays stuck (debounced, and never the same unit and fault twice in a while) — not an oscillation or a
 *   stack, which the census counts instead.
 *
 * An incident becomes a **fixture** (`fixture`): plain JSON for test/incidents/, which test/incidents.test.ts replays
 * from its snapshot through its commands — asserting the replay reaches the captured world exactly (its hash), then
 * its outcome.
 */
import type { Command } from "../sim/command.ts";
import type { WorldSnapshot } from "../sim/snapshot.ts";
import type { MapInfo, SimWorld } from "../sim/world.ts";
import type { Pathology } from "./pathology.ts";
import { fpToTile } from "../sim/components.ts";
import { takeSnapshot, worldHash } from "../sim/snapshot.ts";
import { unitEids } from "../sim/world.ts";
import { createPathologyDetector } from "./pathology.ts";

export interface AppliedCommand { "tick": number; "team": number; "command": Command }

export interface Incident {
	"id": string;
	"label": string;
	/** The snapshot it replays from, and its tick. */
	"baseTick": number;
	"snapshot": WorldSnapshot;
	/** The tick it was flagged at, and the world's hash then (worldHash): a replay must reach exactly this. */
	"flagTick": number;
	"flagHash": number;
	/** Commands applied after the snapshot, up to the flag. A command at tick T was applied in the step that made T. */
	"commands": AppliedCommand[];
	/** The unit it's about, what was wrong with it, and where it was headed (tile). */
	"focus"?: { "uid": number; "pathology": Pathology; "goal": [number, number] };
}

/** An incident as a regression fixture: everything to rebuild the match and replay it, and what to expect. */
export interface Fixture extends Omit<Incident, "flagHash"> {
	/** The match's map, by name (browser/maps.ts) — or the map itself, for one that has none (a test scenario's). */
	"map": string | MapInfo;
	"seed": number;
	"teams": number;
	"expectHash": number;
	/** `pathology`: the replay shows the focus unit's fault again (a known bug, pinned until it's fixed); `reachesGoal`:
	 *  the focus unit gets within a tile of its goal (the bug's fixed — and stays fixed). Within `settleBudget` ticks of
	 *  the flag. */
	"expect": { "pathology"?: Pathology; "reachesGoal"?: boolean; "settleBudget"?: number };
}

export interface RecorderOptions {
	"snapEvery"?: number;
	"keep"?: number;
	"trackLength"?: number;
	/** Ticks between any two automatic incidents; how long a stuck unit must stay stuck to be one; how long before the
	 *  same unit and fault can be one again. */
	"cooldown"?: number;
	"sustain"?: number;
	"dedup"?: number;
	/** Most incidents kept (the oldest go). */
	"maxIncidents"?: number;
}

export interface Recorder {
	/** Pass as the referee's `observe`. */
	"observe": (world: SimWorld, applied: { "team": number; "command": Command }[]) => void;
	/** What the detector finds now. */
	"pathologies": () => { "uid": number; "pathology": Pathology }[];
	"incidents": () => { "id": string; "label": string; "baseTick": number; "flagTick": number; "commands": number; "focus"?: Incident["focus"] }[];
	"incident": (id: string) => Incident | undefined;
	/** Capture now, as an incident. */
	"flag": (world: SimWorld, label: string, focus?: Incident["focus"]) => Incident;
	/** Incident `id` as a fixture of `match`. */
	"fixture": (id: string, match: { "map": string | MapInfo; "seed": number; "teams": number }) => Fixture | undefined;
	/** A unit's track: each tile it entered, and when (its last `trackLength`). */
	"track": (uid: number) => { "tick": number; "tile": [number, number] }[];
	/** The commands applied since the oldest snapshot. */
	"commands": () => AppliedCommand[];
	/** Forget the past (the world was restored: a replay). Incidents are kept. */
	"reset": () => void;
}

/** How far back the command log reaches (30 s). */
const LOG_TICKS = 600;

export function createRecorder({ snapEvery = 30, keep = 6, trackLength = 200, cooldown = 100, sustain = 20, dedup = 600, maxIncidents = 50 }: RecorderOptions = {}): Recorder {
	const detector = createPathologyDetector();
	let snapshots: { "tick": number; "snapshot": WorldSnapshot }[] = [];
	let log: AppliedCommand[] = [];
	const tracks = new Map<number, { "tick": number; "tile": [number, number] }[]>();
	let current = new Map<number, Pathology>();
	const incidents: Incident[] = [];
	const flagged = new Map<string, number>();
	let lastAuto = -Infinity;
	let next = 1;

	function flag(world: SimWorld, label: string, focus?: Incident["focus"]): Incident {
		const base = snapshots[0] ?? { "tick": world.tick, "snapshot": takeSnapshot(world) };
		const incident: Incident = {
			"id": `inc_${next}`,
			"label": label,
			"baseTick": base.tick,
			"snapshot": structuredClone(base.snapshot),
			"flagTick": world.tick,
			"flagHash": worldHash(world),
			"commands": log.filter((entry) => entry.tick > base.tick).map((entry) => structuredClone(entry)),
			...focus === undefined ? {} : { "focus": focus }
		};

		next += 1;
		incidents.push(incident);
		incidents.splice(0, Math.max(0, incidents.length - maxIncidents));

		return incident;
	}

	return {
		"observe": (world, applied) => {
			const { tick } = world;
			const { MoveTarget, Path, UnitId } = world.components;

			for (const { team, command } of applied) {
				log.push({ "tick": tick, "team": team, "command": structuredClone(command) });
			}

			if (tick % snapEvery === 0) {
				snapshots.push({ "tick": tick, "snapshot": takeSnapshot(world) });
				snapshots.splice(0, Math.max(0, snapshots.length - keep));
			}

			// The last LOG_TICKS of commands: an incident takes those after its snapshot; a summary, the latest MOVE.
			log = log.filter((entry) => entry.tick > tick - LOG_TICKS).slice(-500);

			const live = new Set<number>();

			for (const eid of unitEids(world)) {
				const uid = UnitId.id[eid];
				const track = tracks.get(uid) ?? [];
				const last = track.at(-1)?.tile;

				live.add(uid);

				if (last === undefined || last[0] !== Path.curTx[eid] || last[1] !== Path.curTy[eid]) {
					track.push({ "tick": tick, "tile": [Path.curTx[eid], Path.curTy[eid]] });
					track.splice(0, Math.max(0, track.length - trackLength));
					tracks.set(uid, track);
				}
			}

			for (const uid of tracks.keys()) {
				if (!live.has(uid)) {
					tracks.delete(uid);
				}
			}

			current = detector.scan(world, applied.map((entry) => entry.command));

			// The worst current fault, debounced: a give-up, a settle short or a stall at once; a stuck unit once it's stayed
			// stuck — never the same unit and fault twice within `dedup`. Not an oscillation, nor a stack: both are common
			// (every group moving together stacks, until W6 keeps movers apart) and counted by the census instead.
			if (current.size > 0 && tick - lastAuto >= cooldown) {
				for (const [uid, pathology] of current) {
					const key = `${pathology}:${uid}`;
					const since = detector.stuckSince(uid);

					if (tick - (flagged.get(key) ?? -Infinity) < dedup || pathology === "oscillating" || pathology === "stacked" || (pathology === "stuck" && (since === undefined || tick - since < sustain))) {
						continue;
					}

					const eid = world.eidOf.get(uid);

					lastAuto = tick;
					flagged.set(key, tick);
					flag(world, `auto: ${pathology} uid${uid}`, { "uid": uid, "pathology": pathology, "goal": eid === undefined ? [0, 0] : [fpToTile(MoveTarget.tx[eid]), fpToTile(MoveTarget.ty[eid])] });
					break;
				}
			}
		},
		"pathologies": () => [...current].map(([uid, pathology]) => ({ "uid": uid, "pathology": pathology })),
		"incidents": () => incidents.map((incident) => ({ "id": incident.id, "label": incident.label, "baseTick": incident.baseTick, "flagTick": incident.flagTick, "commands": incident.commands.length, ...incident.focus === undefined ? {} : { "focus": incident.focus } })),
		"incident": (id) => incidents.find((incident) => incident.id === id),
		"flag": flag,
		"fixture": (id, match) => {
			const incident = incidents.find((candidate) => candidate.id === id);

			if (incident === undefined) {
				return undefined;
			}

			const { flagHash, ...rest } = structuredClone(incident);

			return { ...rest, ...match, "expectHash": flagHash, "expect": incident.focus === undefined ? {} : { "pathology": incident.focus.pathology, "settleBudget": 300 } };
		},
		"track": (uid) => tracks.get(uid) ?? [],
		"commands": () => [...log],
		"reset": () => {
			snapshots = [];
			log = [];
			tracks.clear();
			current = new Map();
			detector.reset();
		}
	};
}
