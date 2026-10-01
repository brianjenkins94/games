/**
 * The observable sim state, as the oracle compares it: what W0 records from the old sim, and what W1's sim has to
 * reproduce, tick for tick. Implementation-agnostic on purpose — types by name (the old sim's ids are the sorted
 * keys of units.json; the new one's needn't be), queues as plain data, explored maps by digest — so each
 * implementation supplies an adapter that produces it, and nothing here depends on either.
 *
 * It covers what a player could see change: where every unit is, where it's going, what it'll do next (its queued
 * orders), what each building is making and where it rallies, and what each team has explored (fog decides pathing).
 * Not internal pathing state (flow fields, corridor waypoints): W1 may restructure that, as long as the units move the
 * same.
 */

export interface CanonicalUnit {
	"uid": number;
	"type": string;
	"team": number;
	/** Fixed-point centre. */
	"x": number;
	"y": number;
	/** Its move target, while it has one. */
	"target"?: [number, number];
	"building"?: { "w": number; "h": number; "buildLeft": number };
	"orders"?: ({ "kind": "move"; "txFP": number; "tyFP": number } | { "kind": "stop" })[];
	"production"?: { "queue": string[]; "ticksLeft": number; "ticksTotal": number };
	"rally"?: [number, number];
}

export interface CanonicalState {
	"tick": number;
	/** In uid order. */
	"units": CanonicalUnit[];
	/** Each team's explored map, as a digest. */
	"explored": Record<number, string>;
}

/** FNV-1a (32-bit) over a string, as 8 hex digits. */
export function fnv(text: string): string {
	let hash = 0x811c9dc5;

	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}

	return hash.toString(16).padStart(8, "0");
}

/** A state's digest: what a trace records for every tick. */
export function digest(state: CanonicalState): string {
	return fnv(JSON.stringify(state));
}
