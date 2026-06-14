/**
 * Referee-side command validation (anti-cheat).
 *
 * The referee is authoritative, so a compromised client's only lever is the
 * commands it sends.  Each command is checked against the issuing client's team
 * before it touches the sim:
 *   • MOVE / STOP  — may only reference units the issuer actually owns.
 *   • SPAWN / BUILD — must be for the issuer's own team, and may not exceed a
 *     generous live-unit cap (the "can't make a million units" guard, now actually
 *     enforceable because the referee is the sole creator of units).
 *
 * Placement legality for BUILD is re-checked at apply-time in systems/commands.ts
 * (the deterministic source of truth), so it isn't duplicated here.
 */
import { CmdType, type Command } from "../net/protocol";
import { eidForUnitId, unitEids, type SimWorld } from "./world";
import { Unit } from "./components";

/** Generous concurrent unit cap per team — a sanity bound, not an economy rule. */
export const MAX_LIVE_UNITS = 400;

function teamUnitCount(world: SimWorld, team: number): number {
    let n = 0;
    for (const eid of unitEids(world)) if (Unit.team[eid] === team) n++;
    return n;
}

/** True if `cmd` from a client on `team` is legal to apply. */
export function validateCommand(world: SimWorld, team: number, cmd: Command): boolean {
    switch (cmd.type) {
        case CmdType.MOVE:
        case CmdType.STOP:
            // Every referenced unit must exist and belong to the issuer.
            return cmd.unitIds.length > 0 && cmd.unitIds.every(uid => {
                const eid = eidForUnitId(uid);
                return eid !== undefined && Unit.team[eid] === team;
            });
        case CmdType.SPAWN:
        case CmdType.BUILD:
            return cmd.team === team && teamUnitCount(world, team) < MAX_LIVE_UNITS;
    }
}
