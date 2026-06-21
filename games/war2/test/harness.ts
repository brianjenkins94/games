/**
 * High-level driving helpers over the inspector WS: load a scenario, issue moves, step the sim, and
 * read results. Keeps the test files declarative.
 */
import { type Inspector, sleep } from "./ws";
import { type MapInfo, tcFP, empty5 } from "./fixtures";

/** Is tile (tx,ty) walkable in this map? (gid 0 = blocked; out of bounds = blocked.) */
export function isWalkable(map: MapInfo, tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= map.mapW || ty >= map.mapH) return false;
    return map.gids[ty * map.mapW + tx] !== 0;
}

/** The tiles a unit's centre passed through (host trace segments), oldest → newest. */
export async function tracedTiles(insp: Inspector, uid: number): Promise<[number, number][]> {
    const tr = await insp.query("trace", { uid, from: 0 });
    const segs = tr.units?.[uid] ?? [];
    return segs.map((s: { tx: number; ty: number }) => [s.tx, s.ty] as [number, number]);
}

/** Load a scenario with a single team-0 unit at `from` (default: empty 5x5). Returns its uid. */
export async function loadSingleUnit(insp: Inspector, from: [number, number], mapInfo: MapInfo = empty5()): Promise<number> {
    insp.ctrl({ cmd: "load-scenario", scenario: { mapInfo, spawns: [{ team: 0, tx: from[0], ty: from[1] }] } });
    await sleep(300);
    const st = await insp.query("state");
    return st.host?.units?.[0]?.uid ?? 1;
}

/** Issue a MOVE for `uid` toward tile `to`. */
export function move(insp: Inspector, uid: number, to: [number, number]): void {
    insp.ctrl({ cmd: "command", command: { type: 1, unitIds: [uid], txFP: tcFP(to[0]), tyFP: tcFP(to[1]) } });
}

/** Step the sim in batches until the unit settles (moveActive=0) or a tick cap is reached, then
 *  return the `summarize` of the last MOVE (per-unit reached / settle / finalDist / maxStuck). */
export async function runUntilSettled(insp: Inspector, uid: number, maxTicks = 200, batch = 12): Promise<any> {
    for (let t = 0; t < maxTicks; t += batch) {
        insp.ctrl({ cmd: "step", n: batch });
        await sleep(120);
        const u = (await insp.query("unit", { uid })).host;
        if (u && !u.moveActive) break;
    }
    // The sim has settled, but `step` advances faster than real time, so the renderer is still
    // gliding the sprite to the goal — pause so it visibly arrives before the next scenario clears it.
    await sleep(600);
    return insp.query("summarize");
}
