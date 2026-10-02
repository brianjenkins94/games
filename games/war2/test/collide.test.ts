/**
 * The collision shape (W6 step 2, src/sim/collide.ts): one octagon for every collider, two of them overlapping exactly
 * when their offset is inside their sum. Checked exhaustively against the formulas it replaced — the units' L1
 * diamonds and the buildings' inset octagons — so the refactor's claim (no trace moved) has its reason here too.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildingShape, chamfered, depth, diamond, inset, inside, overlaps, POINT, sum, unitShape, WALL } from "../src/sim/collide.ts";
import { FP } from "../src/sim/components.ts";
import { unitTypeId } from "../src/sim/unitTypes.ts";

const span = (from: number, to: number, step: number): number[] => Array.from({ "length": Math.floor((to - from) / step) + 1 }, (_, index) => from + index * step);

test("two diamonds overlap exactly when their L1 distance is under their summed radii — touching is clear", () => {
	for (const [ra, rb] of [[16, 16], [16, 32], [32, 32], [8, 16]]) {
		const [a, b] = [diamond(ra), diamond(rb)];

		for (const dx of span(-70, 70, 1)) {
			for (const dy of span(-70, 70, 1)) {
				assert.equal(overlaps(a, b, dx, dy), Math.abs(dx) + Math.abs(dy) < ra + rb, `r ${ra}+${rb} at ${dx},${dy}`);
			}
		}
	}
});

test("a building and a unit overlap exactly as the old inset-octagon test said", () => {
	const HALF = 16 * FP;
	const MARGIN = 8 * FP;

	for (const [fw, fh] of [[1, 1], [2, 2], [3, 3], [4, 4], [2, 3]]) {
		const bxh = Math.max(0, fw * HALF - MARGIN);
		const byh = Math.max(0, fh * HALF - MARGIN);
		const dd = Math.max(0, bxh + byh - MARGIN);

		for (const r of [16 * FP, 32 * FP]) {
			for (const dx of span(-100 * FP, 100 * FP, 2 * FP)) {
				for (const dy of span(-100 * FP, 100 * FP, 2 * FP)) {
					const old = Math.abs(dx) < bxh + r && Math.abs(dy) < byh + r && Math.abs(dx) + Math.abs(dy) < dd + r;

					assert.equal(overlaps(buildingShape(fw, fh), diamond(r), dx, dy), old, `${fw}×${fh}, r ${r}, at ${dx},${dy}`);
				}
			}
		}
	}
});

test("a box (no corner cut) overlaps as two boxes do; a full cut is a diamond", () => {
	const box = chamfered(10, 6, 0);

	assert.deepEqual(box, { "w": 10, "h": 6, "d": 16 });
	assert.deepEqual(chamfered(8, 8, 8), diamond(8));

	for (const dx of span(-30, 30, 1)) {
		for (const dy of span(-30, 30, 1)) {
			assert.equal(overlaps(box, chamfered(4, 4, 0), dx, dy), Math.abs(dx) < 14 && Math.abs(dy) < 10);
		}
	}
});

test("the sum is the C-space: a point inside it is an overlap, and it's the same either way round", () => {
	const [a, b] = [buildingShape(2, 3), diamond(16 * FP)];

	assert.deepEqual(sum(a, b), sum(b, a));

	for (const dx of span(-90 * FP, 90 * FP, 3 * FP)) {
		for (const dy of span(-90 * FP, 90 * FP, 3 * FP)) {
			const s = sum(a, b);

			assert.equal(inside(s.w, s.h, s.d, dx, dy), overlaps(a, b, dx, dy));
			assert.equal(overlaps(s, POINT, dx, dy), overlaps(a, b, dx, dy));
		}
	}
});

test("depth: positive exactly when overlapping, and for diamonds the summed radii less the L1 distance", () => {
	const [a, b] = [diamond(16), diamond(16)];

	for (const dx of span(-40, 40, 1)) {
		for (const dy of span(-40, 40, 1)) {
			assert.equal(depth(a, b, dx, dy) > 0, overlaps(a, b, dx, dy));

			if (overlaps(a, b, dx, dy)) {
				assert.equal(depth(a, b, dx, dy), 32 - Math.abs(dx) - Math.abs(dy));
			}
		}
	}

	assert.deepEqual(inset(diamond(16), 8), diamond(8));
	assert.deepEqual(inset(diamond(16), -12), diamond(28));
});

test("a one-tile unit at the corner between two diagonal walls touches both and overlaps neither: it threads the pinch", () => {
	const unit = unitShape(unitTypeId("unit-footman"));
	const corner = 32 * FP;
	// Walls in the tiles up-left and down-right of the corner: centres half a tile away on both axes.
	const [wall1, wall2] = [[16 * FP, 16 * FP], [48 * FP, 48 * FP]];

	assert.deepEqual(unit, diamond(16 * FP));

	for (const [cx, cy] of [wall1, wall2]) {
		assert.equal(overlaps(WALL, unit, corner - cx, corner - cy), false, "touching, not overlapping");
		assert.equal(depth(WALL, unit, corner - cx, corner - cy), 0);
	}

	// A pixel off the diagonal, it would overlap one of them.
	assert.equal(overlaps(WALL, unit, corner + 1 * FP - wall1[0], corner - wall1[1]) || overlaps(WALL, unit, corner + 1 * FP - wall2[0], corner - wall2[1]), true);
});
