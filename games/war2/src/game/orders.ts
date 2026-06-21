/**
 * Unit orders — translating a player command (move / formation / gather / stop / preview) into the
 * per-unit MoveTarget + flow-field goal the movement system steers on.  This is the "intent" layer:
 * it decides WHERE each unit should go (slot assignment, passable-tile snapping, the shared per-group
 * flow goal) and hands off to systems/movement.ts for the per-tick stepping.  Split out of world.ts.
 *
 * Determinism: every function here is a pure function of shared sim state (positions, believed
 * passability, the flow-field cache) — no wall-clock, no RNG — so issuing the same order on both peers
 * produces identical MoveTarget/Path state.
 */
import { hasComponent } from "bitecs";
import { Position, MoveTarget, Unit, Path, UnitAnim, Building, FP, TILE_PX, WALK_PX, tileCenterFP, fpToTile, snapWalkFP } from "./components";
import { unitRadiusPx } from "./unitTypes";
import { distance } from "./distance";
import { getMapW, getMapH } from "./passability";
import { footprintSoftFreeAt } from "./walkGrid";
import { markIdleDirty } from "./pathObstacles";
import { getOrComputeFlowField, UNREACHABLE } from "./flowField";
import { getBelievedPassability } from "./vision";
import { stopUnit as _stopUnit } from "./systems/movement";
import { unitEids, type SimWorld } from "./world";

/**
 * Render-only preview of a move command.
 *
 * Sets ONLY UnitAnim.dir and UnitAnim.moving — pure render hints that the
 * movement system overwrites on its next step and that never enter the world
 * hash or any movement decision.  Position, MoveTarget, Path, and occupancy are
 * deliberately left untouched.
 *
 * This gives instant visual feedback (the unit turns to face its goal and plays
 * its walk cycle) without advancing sim state ahead of the authoritative
 * command.  The real movement — curTx/curTy, occupancy, MoveTarget — happens
 * only via setMoveTarget applied from a command, at the same tick on
 * both sims, so there is no divergence.
 *
 * Determinism note: setting UnitAnim here is safe precisely because UnitAnim is
 * write-only from the sim's perspective (the movement system sets it; nothing
 * reads it back) and is excluded from worldHash.  Setting MoveTarget.active or
 * Path.active here would NOT be safe — the deterministic movement system acts on
 * those, which would move the predicting player's units ahead of the host.
 */
export function previewMoveTarget(_world: SimWorld, eid: number, txFP: number, tyFP: number): void {
    const team = Unit.team[eid];
    const pass = getBelievedPassability(team);   // fog-aware (matches setMoveTarget)
    const mapW = getMapW();

    let goalTx   = fpToTile(txFP);
    let goalTy   = fpToTile(tyFP);
    const curTx  = Path.curTx[eid];
    const curTy  = Path.curTy[eid];

    if (curTx === goalTx && curTy === goalTy) return;

    let dir: number;
    if (pass) {
        if (pass[goalTy * mapW + goalTx]) {
            // Blocked terrain — preview toward the nearest walkable tile (matches
            // setMoveTarget so the instant facing agrees with where it'll go).
            const near = nearestPassableTile(team, goalTx, goalTy);
            if (!near) return;
            [goalTx, goalTy] = near;
            if (curTx === goalTx && curTy === goalTy) return;
        }
        const ff = getOrComputeFlowField(team, goalTx, goalTy);
        if (!ff) return;
        const myIdx = curTy * mapW + curTx;
        const d = ff.dirs[myIdx];
        if (d === UNREACHABLE) return;
        dir = d;
    } else {
        // Pre-map fallback (dev only): face the raw delta, 8-way.
        dir = octantFromDelta(txFP - Position.x[eid], tyFP - Position.y[eid]);
    }

    UnitAnim.dir[eid]    = dir;
    UnitAnim.moving[eid] = 1;
}

/** 8-way octant (0=N..7=NW) from a world-space delta. */
function octantFromDelta(dx: number, dy: number): number {
    const a = (Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
    return Math.round(a / (Math.PI / 4)) & 7;
}

/**
 * Passable tile nearest to (tx,ty).  When a move is ordered onto blocked terrain
 * (right-clicking a tree, water, a cliff…), units should still gather as close to
 * the click as possible rather than ignore the order — so the goal is snapped to
 * the closest walkable tile.
 *
 * Deterministic (safe in the authoritative sim): expands in Chebyshev rings of
 * increasing radius and, within a ring, picks the candidate with the smallest
 * integer dodecagon distance to the click, breaking ties by scan order.  Returns
 * the tile itself if it is already passable, or null if the map has none.
 */
function nearestPassableTile(team: number, tx: number, ty: number): [number, number] | null {
    const pass = getBelievedPassability(team);   // fog-aware: unexplored counts as passable
    const mapW = getMapW();
    const mapH = getMapH();
    if (!pass) return [tx, ty];
    const inBounds = (x: number, y: number) => x >= 0 && x < mapW && y >= 0 && y < mapH;
    if (inBounds(tx, ty) && !pass[ty * mapW + tx]) return [tx, ty];

    const maxR = Math.max(mapW, mapH);
    for (let r = 1; r <= maxR; r++) {
        let best: [number, number] | null = null;
        let bestD = Infinity;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;  // ring edge only
                const x = tx + dx, y = ty + dy;
                if (!inBounds(x, y) || pass[y * mapW + x]) continue;        // off-map / blocked
                const d = distance(dx, dy);
                if (d < bestD) { bestD = d; best = [x, y]; }
            }
        }
        if (best) return best;
    }
    return null;
}

/** Authoritative halt — clears movement/path/anim state (occupancy unchanged). */
export function stopUnit(_world: SimWorld, eid: number): void {
    _stopUnit(eid);
}

/**
 * Issue a move order. Returns whether an order was actually applied: `false` means
 * the unit got no order (no reachable passable tile near the goal, or — when
 * `snapBlocked` is false — the requested tile is itself blocked).
 *
 * `snapBlocked` (default true): if the goal tile is impassable, retarget the nearest
 * walkable tile.  A formation move passes `false` for the per-unit slot so a blocked
 * slot is *rejected* (caller collapses that unit onto the shared destination) instead
 * of scatter-snapping it to some random nearby pocket and shredding the formation.
 *
 * `flowTxOpt`/`flowTyOpt` (default -1 = unset): the SHARED flow-field goal tile for a group move — the
 * group's common destination, so all N units read ONE cached field (one Dijkstra) for long-range
 * navigation while each still targets its own slot point (txFP/tyFP) for the local approach + settle.
 * Unset → the flow goal IS this unit's slot tile (a standalone move navigates straight to its target).
 */
export function setMoveTarget(
    _world: SimWorld, eid: number, txFP: number, tyFP: number,
    snapBlocked = true, avoidUnits = false,
    flowTxOpt = -1, flowTyOpt = -1,
): boolean {
    const team = Unit.team[eid];
    markIdleDirty();   // this unit is (un)settling → its tile leaves/joins the path-obstacle set
    const pass = getBelievedPassability(team);   // fog-aware: may path into assumed-passable fog
    const mapW = getMapW();

    if (!pass) {
        // No map loaded — direct movement fallback (pre-map mode)
        MoveTarget.tx[eid]     = txFP;
        MoveTarget.ty[eid]     = tyFP;
        MoveTarget.active[eid] = 1;
        Path.active[eid]       = 0;
        Path.stuckTicks[eid]   = 0;
        return true;
    }

    // Rest on the 8px collision grid (snapWalkFP), not the 32px tile centre — so a unit can anchor
    // at a sub-tile position while still landing grid-clean (a 32px box on the 8px grid = 4 whole
    // cells).  The goal *tile* (for the flow field + passability) is derived from the snapped point.
    let goalXFP = snapWalkFP(txFP);
    let goalYFP = snapWalkFP(tyFP);
    let goalTx  = fpToTile(goalXFP);
    let goalTy  = fpToTile(goalYFP);

    if (pass[goalTy * mapW + goalTx]) {
        // Blocked terrain (tree/water/cliff). For a formation slot, reject so the caller can fall
        // back to the group destination; otherwise aim for the nearest passable tile *centre*.
        if (!snapBlocked) return false;
        const near = nearestPassableTile(team, goalTx, goalTy);
        if (!near) return false;
        [goalTx, goalTy] = near;
        goalXFP = tileCenterFP(goalTx);
        goalYFP = tileCenterFP(goalTy);
    }

    // Correct the destination off any *settled* unit sitting on it (avoidUnits = a standalone move; group
    // moves spread via the formation/gather slot logic instead).  Rather than letting the unit walk onto
    // an occupied tile and resolve the overlap at settle (which dwells then pops), retarget the nearest
    // tile whose footprint is clear up front, so it paths to a clean rest spot.  Ignores *moving* units
    // (they clear) — only parked units relocate the goal.
    if (avoidUnits) {
        const rad = unitRadiusPx(Unit.type[eid]) * FP;
        if (!footprintSoftFreeAt(goalXFP, goalYFP, rad, eid)) {
            const STEP = TILE_PX * FP;
            const mapH = getMapH();
            search:
            for (let r = 1; r <= 6; r++) {
                for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    const fx = goalXFP + dx * STEP, fy = goalYFP + dy * STEP;
                    const tx = fpToTile(fx), ty = fpToTile(fy);
                    if (tx < 0 || ty < 0 || tx >= mapW || ty >= mapH) continue;
                    if (pass[ty * mapW + tx]) continue;                        // blocked terrain
                    if (footprintSoftFreeAt(fx, fy, rad, eid)) {
                        goalXFP = fx; goalYFP = fy; goalTx = tx; goalTy = ty;
                        break search;
                    }
                }
            }
        }
    }

    // Flow-field goal: the SHARED group destination (one cached field for the whole group), distinct from
    // this unit's own slot tile (goalTx/goalTy) which the local layer peels it onto at the end.  A
    // standalone move passes no flow goal → it navigates straight to its own slot tile as before.  Snap a
    // blocked shared goal (e.g. the click landed on a tree) to the nearest passable tile so the field is
    // computable; fall back to the slot tile if there's no passable tile near the shared goal.
    let flowTx = flowTxOpt, flowTy = flowTyOpt;
    if (flowTx < 0 || flowTy < 0) { flowTx = goalTx; flowTy = goalTy; }
    else if (pass[flowTy * mapW + flowTx]) {
        const nf = nearestPassableTile(team, flowTx, flowTy);
        if (nf) [flowTx, flowTy] = nf; else { flowTx = goalTx; flowTy = goalTy; }
    }

    const curTx = fpToTile(Position.x[eid]);
    const curTy = fpToTile(Position.y[eid]);

    // Record the unit's SLOT point (its final target) and the SHARED flow goal that steers it there.
    // Path.goalTx/goalTy is the flow-field key (shared across the group); the slot tile is derived from
    // MoveTarget.tx/ty by the movement system for its near-goal handoff.
    Path.goalTx[eid]       = flowTx;
    Path.goalTy[eid]       = flowTy;
    MoveTarget.tx[eid]     = goalXFP;
    MoveTarget.ty[eid]     = goalYFP;
    Path.stuckTicks[eid]   = 0;

    if (curTx === goalTx && curTy === goalTy) {
        // Already standing in the slot tile — just nudge toward the exact point (no flow needed).
        MoveTarget.active[eid] = 1;
        Path.active[eid]       = 1;
        return true;
    }

    // Pre-warm the shared flow field (all N units of a group share ONE goal → one Dijkstra) and skip the
    // order if this unit can't reach the shared destination at all.
    const ff = getOrComputeFlowField(team, flowTx, flowTy);
    if (!ff) return false;
    if (ff.dirs[curTy * mapW + curTx] === UNREACHABLE) return false;

    MoveTarget.active[eid] = 1;
    Path.active[eid]       = 1;
    return true;
}

/**
 * Tiles currently held by a SETTLED unit *outside* `group` — seeded into a formation's `claimed`
 * reservation set so a slot never lands on a parked unit.  Without this a slot is chosen on terrain
 * alone; the unit then walks onto the occupied tile and `settleOnto`'s ring-search relocates it at the
 * final tick — the "unit zooms into a different space" teleport.  Group members and still-moving units
 * are excluded (they'll vacate their tile), as are buildings (already static terrain via passability).
 * Deterministic: a pure scan of Position/MoveTarget in eid order.
 */
function occupiedTilesOutside(world: SimWorld, group: number[], mapW: number): Set<number> {
    const inGroup = new Set(group);
    const taken = new Set<number>();
    for (const e of unitEids(world)) {
        if (inGroup.has(e) || MoveTarget.active[e] === 1 || hasComponent(world, e, Building)) continue;
        taken.add(fpToTile(Position.y[e]) * mapW + fpToTile(Position.x[e]));
    }
    return taken;
}

/**
 * Greedily map a set of units onto a set of slot centres and issue the moves.  Slots are filled in
 * an order chosen by `fill`, each going to its nearest still-unassigned unit:
 *   "far"  — furthest slot from the group first.  A *translating* formation thus has its leading
 *            edge claim the deepest slots, so the block unrolls into place without units crossing.
 *   "near" — nearest slot first.  A *converging* cluster barely shuffles (minimal total travel).
 * Surplus units (more units than slots) fall back to the click point; an unreachable slot too.
 * Deterministic: distance sort + nearest-unit pick are pure, with eid tie-breaks.
 */
function assignUnitsToSlots(
    world: SimWorld, eids: number[], slots: Array<[number, number]>,
    fill: "far" | "near", txFP: number, tyFP: number,
): void {
    let gcx = 0, gcy = 0;
    for (const e of eids) { gcx += Position.x[e]; gcy += Position.y[e]; }
    gcx = (gcx / eids.length) | 0; gcy = (gcy / eids.length) | 0;

    // Sub-tile anchor: the slots are tile-centred, but shift the whole block by how far the click sat
    // from its own tile centre (snapped to the 8px grid, clamped to ±8px so each unit stays in its
    // passable slot tile).  This anchors the formation where you clicked, not on the 32px lattice.
    const cap = WALK_PX * FP;
    const clamp = (v: number) => v < -cap ? -cap : v > cap ? cap : v;
    const shiftX = clamp(snapWalkFP(txFP) - tileCenterFP(fpToTile(txFP)));
    const shiftY = clamp(snapWalkFP(tyFP) - tileCenterFP(fpToTile(tyFP)));

    const sign = fill === "far" ? -1 : 1;   // "far" → descending distance from the group centroid
    const order = slots.map((_, i) => i).sort((a, b) =>
        sign * (distance(slots[a][0] - gcx, slots[a][1] - gcy) - distance(slots[b][0] - gcx, slots[b][1] - gcy)) || (a - b));

    // One SHARED flow-field goal for the whole group (the click destination tile): every unit reads the
    // same cached field for long-range navigation (one Dijkstra, not one-per-slot) and peels onto its own
    // slot via the local layer near the end.  setMoveTarget snaps it to passable if the click was blocked.
    const flowTx = fpToTile(txFP), flowTy = fpToTile(tyFP);
    // Issue a move toward (tx,ty) with the group's shared flow goal; returns false if unreachable.
    const place = (e: number, tx: number, ty: number) => setMoveTarget(world, e, tx, ty, true, false, flowTx, flowTy);

    const remaining = [...eids];
    const n = Math.min(eids.length, slots.length);
    for (let k = 0; k < n; k++) {
        const sx = slots[order[k]][0] + shiftX, sy = slots[order[k]][1] + shiftY;
        let bi = 0, bd = Infinity;                                  // nearest unassigned unit to this slot
        for (let i = 0; i < remaining.length; i++) {
            const e = remaining[i];
            const d = distance(Position.x[e] - sx, Position.y[e] - sy);
            if (d < bd || (d === bd && e < remaining[bi])) { bd = d; bi = i; }
        }
        const e = remaining.splice(bi, 1)[0];
        if (!place(e, sx, sy)) place(e, txFP, tyFP);                // blocked slot → fall back to the centre
    }
    for (const e of remaining) place(e, txFP, tyFP);               // more units than slots → centre
}

/**
 * Hold formation while keeping every unit on passable, *distinct* ground.  The slot block is the
 * group's arrangement (each unit's centroid offset) translated to the click point — an axis-aligned
 * translation, so the shape is preserved.  A slot on impassable terrain (or colliding with another)
 * reflows outward to the nearest free passable tile, so the block deforms *locally* around the
 * obstacle instead of collapsing onto the click point.  Units are then assigned furthest-slot-first
 * so a translating formation unrolls into place without crossing (see assignUnitsToSlots).
 *
 * Deterministic: centroid, passability and the spiral search are pure functions of shared state,
 * built in eid order (claims are order-dependent but reproduced by replay).
 */
export function setFormationTargets(world: SimWorld, eids: number[], txFP: number, tyFP: number): void {
    const team = Unit.team[eids[0]];
    const pass = getBelievedPassability(team);
    const mapW = getMapW(), mapH = getMapH();
    if (!pass) { for (const e of eids) setMoveTarget(world, e, txFP, tyFP); return; }

    const passable = (x: number, y: number) =>
        x >= 0 && x < mapW && y >= 0 && y < mapH && !pass[y * mapW + x];

    let sx = 0, sy = 0;
    for (const e of eids) { sx += Position.x[e]; sy += Position.y[e]; }
    const cx = (sx / eids.length) | 0, cy = (sy / eids.length) | 0;

    // Build the formation slots: each unit's offset tile, reflowed to the nearest free passable tile.
    // Seed `claimed` with tiles held by settled non-group units so a slot never targets a parked unit
    // (which would walk the unit there then teleport it off at settle — see occupiedTilesOutside).
    const claimed = occupiedTilesOutside(world, eids, mapW);
    const slots: Array<[number, number]> = [];
    const maxR = Math.max(mapW, mapH);
    for (const e of eids) {
        const dtx = fpToTile(txFP + (Position.x[e] - cx));
        const dty = fpToTile(tyFP + (Position.y[e] - cy));
        for (let r = 0; r <= maxR; r++) {
            let placed = false;
            for (let dy = -r; dy <= r && !placed; dy++) for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;       // ring edge only
                const gx = dtx + dx, gy = dty + dy, key = gy * mapW + gx;
                if (passable(gx, gy) && !claimed.has(key)) {
                    claimed.add(key); slots.push([tileCenterFP(gx), tileCenterFP(gy)]); placed = true; break;
                }
            }
            if (placed) break;
        }
    }
    if (slots.length === 0) { for (const e of eids) setMoveTarget(world, e, txFP, tyFP); return; }

    assignUnitsToSlots(world, eids, slots, "far", txFP, tyFP);
}

/**
 * Gather a group tightly around a point: each unit is given its own tile-centred slot in a
 * compact spiral of passable tiles around the destination, so the selection packs into a
 * neat grid-aligned block instead of all piling onto the exact click point.  Slots are one
 * tile apart, which matches a 32px unit box, so they settle cleanly without fighting the
 * walk-grid reservation.
 *
 * Slots are filled nearest-first (assignUnitsToSlots "near"): each unit takes the closest slot, so
 * a converging cluster barely shuffles — minimal travel, minimal jostling, a tidy block.
 *
 * Used for "converge" moves (re-click the same spot, or a too-scattered selection) — see
 * systems/commands.ts.  Deterministic: spiral order, passability and the nearest-first assignment
 * (eid tie-breaks) are all pure functions of shared state.
 */
export function setGatherTargets(world: SimWorld, eids: number[], txFP: number, tyFP: number): void {
    const team = Unit.team[eids[0]];
    const pass = getBelievedPassability(team);
    const mapW = getMapW(), mapH = getMapH();
    if (!pass) { for (const e of eids) setMoveTarget(world, e, txFP, tyFP); return; }

    const inBounds = (x: number, y: number) => x >= 0 && x < mapW && y >= 0 && y < mapH;
    const passable = (x: number, y: number) => inBounds(x, y) && !pass[y * mapW + x];
    // A slot tile is free only if it's passable AND not held by a settled non-group unit (so the block
    // packs around parked units instead of targeting their tile and teleporting off at settle).
    const taken = occupiedTilesOutside(world, eids, mapW);
    const free = (x: number, y: number) => passable(x, y) && !taken.has(y * mapW + x);

    // Centre the cluster on passable ground.
    let ctx = fpToTile(txFP), cty = fpToTile(tyFP);
    if (!passable(ctx, cty)) {
        const near = nearestPassableTile(team, ctx, cty);
        if (near) [ctx, cty] = near;
    }

    // Slot block, near-square so the group packs into a tidy rectangle (4 → 2×2, 9 → 3×3)
    // rather than a spread line.  Fill the rectangle's passable tiles first, then — if blocked
    // terrain left us short — expand outward ring by ring to make up the count.
    const count = eids.length;
    const cols  = Math.round(Math.sqrt(count)) || 1;
    const rows  = Math.ceil(count / cols);
    const left = ctx - ((cols - 1) >> 1), top = cty - ((rows - 1) >> 1);
    const inRect = (x: number, y: number) => x >= left && x < left + cols && y >= top && y < top + rows;

    const scx: number[] = [], scy: number[] = [];   // slot centres (fixed-point)
    for (let ry = 0; ry < rows; ry++) for (let rx = 0; rx < cols; rx++) {
        if (free(left + rx, top + ry)) { scx.push(tileCenterFP(left + rx)); scy.push(tileCenterFP(top + ry)); }
    }
    const maxR = Math.max(mapW, mapH);
    for (let r = 1; r <= maxR && scx.length < count; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;     // ring edge only
                if (inRect(ctx + dx, cty + dy)) continue;                      // already considered
                if (free(ctx + dx, cty + dy)) { scx.push(tileCenterFP(ctx + dx)); scy.push(tileCenterFP(cty + dy)); }
            }
        }
    }
    if (scx.length === 0) { for (const e of eids) setMoveTarget(world, e, txFP, tyFP); return; }

    // Converging in place → fill the NEAREST slot first, so units barely shuffle (minimal travel).
    assignUnitsToSlots(world, eids, scx.map((cx, i) => [cx, scy[i]]), "near", txFP, tyFP);
}
