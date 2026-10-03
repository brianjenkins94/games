/**
 * The bot a client plays with when nobody's clicking (`?bots`, on by default): now and then it sends one of its own
 * idle-looking units somewhere random. A load generator for tests and demos — the place a real bot would grow.
 *
 * It decides from what its client sees (its own units, not the world) and is seeded by its player's name, so a run
 * repeats.
 */
import type { Command } from "./command.ts";
import { CmdType } from "./command.ts";
import { tileCenterFP } from "./components.ts";
import { createRng } from "./rng.ts";

/** A unit as the bot sees it: which one, and whether it's a building. */
export interface BotUnit {
	"uid": number;
	"building"?: unknown;
}

/** A bot for player `name` on a `mapW`×`mapH` map: each tick, given its own units and the ones its player has selected
 *  (left alone), maybe a command. */
export function createBot(name: string, mapW: number, mapH: number): (own: BotUnit[], selected: number[]) => Command | undefined {
	const next = createRng([...name].reduce((sum, char) => sum + char.charCodeAt(0), 7));
	const random = (bound: number): number => next() % bound;

	return (own, selected) => {
		if (random(100) >= 10) {
			return undefined;
		}

		const units = own.filter((unit) => unit.building === undefined && !selected.includes(unit.uid));

		if (units.length === 0) {
			return undefined;
		}

		return { "type": CmdType.MOVE, "unitIds": [units[random(units.length)].uid], "txFP": tileCenterFP(random(mapW)), "tyFP": tileCenterFP(random(mapH)) };
	};
}
