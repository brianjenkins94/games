/**
 * Where a client's view differs from authority: unit by unit, field by field. Only meaningful for the same tick (the
 * referee paused, or a recorded pair) — at different ticks everything that moved "differs".
 */
import type { Unit } from "../sim/index.ts";
import { UNIT_FIELDS } from "../sim/index.ts";

export interface Divergence {
	/** Units authority has (that the team can see) and the client doesn't. */
	"missing": number[];
	/** Units the client has and authority doesn't show the team. */
	"extra": number[];
	"differing": { "id": number; "field": typeof UNIT_FIELDS[number]; "authority": number; "client": number }[];
}

export function diffUnits(authority: Iterable<Unit>, client: Iterable<Unit>): Divergence {
	const expected = new Map([...authority].map((unit) => [unit.id, unit]));
	const actual = new Map([...client].map((unit) => [unit.id, unit]));
	const divergence: Divergence = { "missing": [], "extra": [], "differing": [] };

	for (const [id, unit] of expected) {
		const other = actual.get(id);

		if (other === undefined) {
			divergence.missing.push(id);

			continue;
		}

		for (const field of UNIT_FIELDS) {
			if (unit[field] !== other[field]) {
				divergence.differing.push({ "id": id, "field": field, "authority": unit[field], "client": other[field] });
			}
		}
	}

	divergence.extra = [...actual.keys()].filter((id) => !expected.has(id));
	divergence.missing.sort((left, right) => left - right);
	divergence.extra.sort((left, right) => left - right);

	return divergence;
}

export function isEmpty(divergence: Divergence): boolean {
	return divergence.missing.length === 0 && divergence.extra.length === 0 && divergence.differing.length === 0;
}
