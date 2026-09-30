/** One sim tick. Units move in id order, by integer math only, so a tick is exactly reproducible. */
import type { Unit, World } from "./world.ts";
import { approxDistance } from "./fixed.ts";

function moveUnit(unit: Unit, speed: number): void {
	const dx = unit.tx - unit.x;
	const dy = unit.ty - unit.y;
	const distance = approxDistance(dx, dy);

	if (distance <= speed) {
		unit.x = unit.tx;
		unit.y = unit.ty;
		unit.moving = 0;

		return;
	}

	unit.x += Math.trunc((dx * speed) / distance);
	unit.y += Math.trunc((dy * speed) / distance);
}

export function stepWorld(world: World): void {
	for (const unit of world.units.values()) {
		if (unit.moving === 1) {
			moveUnit(unit, world.config.speed);
		}
	}

	world.tick += 1;
}
