import assert from "node:assert/strict";
import { test } from "node:test";
import { diffUnits, isEmpty } from "../../src/net/index.ts";

const unit = (id: number, x = 0, team = 0) => ({ "id": id, "team": team, "x": x, "y": 0, "tx": 0, "ty": 0, "moving": 0 });

test("identical views don't diverge", () => {
	const divergence = diffUnits([unit(1), unit(2)], [unit(2), unit(1)]);

	assert.ok(isEmpty(divergence));
	assert.deepEqual(divergence, { "missing": [], "extra": [], "differing": [] });
});

test("missing, extra and differing units are each reported, in id order", () => {
	const divergence = diffUnits([unit(3), unit(1), unit(2, 5)], [unit(2, 7), unit(9), unit(4)]);

	assert.ok(!isEmpty(divergence));
	assert.deepEqual(divergence.missing, [1, 3]);
	assert.deepEqual(divergence.extra, [4, 9]);
	assert.deepEqual(divergence.differing, [{ "id": 2, "field": "x", "authority": 5, "client": 7 }]);
});
