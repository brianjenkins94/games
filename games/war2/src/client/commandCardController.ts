/**
 * Command-card controller — the single owner of command-card interaction state.
 *
 * It holds the *entire* UI input-mode state machine in one place:
 *   • type  — unit-type of the current selection (drives which card to show)
 *   • page  — "root" or an open submenu (e.g. "build")
 *   • armed — an ability awaiting a target click (targeting mode)
 *
 * Previously `page` lived in the renderer and `armed` lived in a separate FSM,
 * so Escape/cancel had to keep two state machines consistent by hand.  Folding
 * them together removes that hazard: the renderer is now a dumb view (draws a
 * card, reports raw clicks/keys) and this controller decides what everything
 * means and what card to render.
 *
 * Determinism boundary: this is client intent only.  It never mutates the sim —
 * it computes cards (pure `commandCardFor`) and emits `Command`s via `emit`,
 * exactly like a right-click move.  Targeting/placement live on the render side.
 *
 * Only abilities whose sim systems exist today are fully wired (Move→MOVE,
 * Stop→STOP).  Everything else is recognised and logged "not yet implemented".
 */
import { commandCardFor, type CommandCard } from "../game/abilities";
import { CmdType, type Command } from "../net/protocol";
import { unitTypeId, unitFootprint } from "../game/unitTypes";

/** A pending building placement (ghost following the cursor). */
export interface PlacementGhost {
    tileX: number; tileY: number; fw: number; fh: number; valid: boolean;
}

export interface CardControllerDeps {
    /** eids of the player's own currently-selected units. */
    getOwnSelection: () => number[];
    /** Stable UnitId for an eid (UnitId.id[eid]). */
    unitIdOf: (eid: number) => number;
    /** Render-only move preview (previewMoveTarget) — instant visual turn. */
    previewMove: (eid: number, txFP: number, tyFP: number) => void;
    /** Snap an FP world coordinate to its tile centre. */
    snapToTile: (fp: number) => number;
    /** Queue a finalized command for the next tick. */
    emit: (cmd: Command) => void;
    /** Push a freshly-computed card (or null) to the view. */
    render: (card: CommandCard | null) => void;
    /** Toggle the targeting (crosshair) cursor. */
    setTargetingCursor?: (on: boolean) => void;
    /** Informational logging. */
    log?: (msg: string) => void;

    // ── Building placement ──────────────────────────────────────────────────────
    /** The local player's team (stamped onto BUILD commands). */
    myTeam: number;
    /** Mint a fresh stable UnitId for a newly-placed building. */
    consumeUnitId: () => number;
    /** FP world coordinate → tile index. */
    fpToTile: (fp: number) => number;
    /** Can a building of `typeId` be placed with footprint top-left at (tileX,tileY)? */
    canPlaceBuilding: (tileX: number, tileY: number, typeId: number) => boolean;
    /** Show/update (or hide, with null) the placement ghost. */
    showPlacementGhost?: (ghost: PlacementGhost | null) => void;
}

export interface CommandCardController {
    /** Selection changed — set its unit type (null = nothing) and re-render. */
    setSelection(unitType: string | null): void;
    /** A card slot was clicked (raw grid index). */
    slot(index: number): void;
    /** Cursor moved over the map — updates the placement ghost (no-op otherwise). */
    hoverTile(wxFP: number, wyFP: number): void;
    /** Left-click on the map. Returns true if consumed by an armed ability. */
    primaryClick(wxFP: number, wyFP: number): boolean;
    /** Right-click on the map: cancel an armed ability, else issue a move. */
    secondaryClick(wxFP: number, wyFP: number): void;
    /** Escape: cancel armed ability and return the card to its root page. */
    escape(): void;
    /** True while an ability is armed and waiting for a target click. */
    isTargeting(): boolean;
}

export function createCommandCardController(deps: CardControllerDeps): CommandCardController {
    let type:  string | null = null;
    let page:  string = "root";
    let armedId: string | null = null;   // target-click ability awaiting a target
    let placing: { typeId: number; fw: number; fh: number } | null = null;  // building placement

    const log = (m: string) => deps.log?.(m);

    function currentCard(): CommandCard | null {
        return type ? commandCardFor(type, page) : null;
    }
    function rerender(): void { deps.render(currentCard()); }

    /** Clear any armed targeting / placement and reset cursor + ghost. */
    function disarm(): void {
        if (armedId === null && placing === null) return;
        armedId = null;
        placing = null;
        deps.setTargetingCursor?.(false);
        deps.showPlacementGhost?.(null);
    }

    /** Footprint top-left for a building centred under the cursor. */
    function placeOrigin(wxFP: number, wyFP: number, fw: number, fh: number): [number, number] {
        return [deps.fpToTile(wxFP) - (fw >> 1), deps.fpToTile(wyFP) - (fh >> 1)];
    }

    function issueMove(txFP: number, tyFP: number): void {
        const sel = deps.getOwnSelection();
        if (!sel.length) return;
        const sx = deps.snapToTile(txFP), sy = deps.snapToTile(tyFP);
        for (const eid of sel) deps.previewMove(eid, sx, sy);
        deps.emit({ type: CmdType.MOVE, unitIds: sel.map(deps.unitIdOf), txFP: sx, tyFP: sy });
    }
    function issueStop(): void {
        const sel = deps.getOwnSelection();
        if (sel.length) deps.emit({ type: CmdType.STOP, unitIds: sel.map(deps.unitIdOf) });
    }

    return {
        setSelection(unitType: string | null): void {
            type = unitType;
            page = "root";
            disarm();
            rerender();
        },

        slot(index: number): void {
            const card = currentCard();
            const ability = card?.[index];
            if (!ability) return;
            const it = ability.interaction;
            switch (it.kind) {
                case "submenu":      page = it.page; disarm(); rerender(); break;
                case "cancel":       page = "root";  disarm(); rerender(); break;
                case "immediate":
                    disarm();
                    if (ability.id === "stop") issueStop();
                    else log(`${ability.id}: not yet implemented`);
                    break;
                case "targetGround":
                case "targetUnit":
                    armedId = ability.id;
                    deps.setTargetingCursor?.(true);
                    break;
                case "placement": {
                    disarm();
                    const typeId = unitTypeId(it.building);
                    const [fw, fh] = unitFootprint(typeId);
                    placing = { typeId, fw, fh };
                    deps.setTargetingCursor?.(true);
                    break;
                }
                case "produce":
                    disarm();
                    log(`${ability.id}: not yet implemented`);
                    break;
            }
        },

        hoverTile(wxFP: number, wyFP: number): void {
            if (!placing) return;
            const [tileX, tileY] = placeOrigin(wxFP, wyFP, placing.fw, placing.fh);
            deps.showPlacementGhost?.({
                tileX, tileY, fw: placing.fw, fh: placing.fh,
                valid: deps.canPlaceBuilding(tileX, tileY, placing.typeId),
            });
        },

        primaryClick(wxFP: number, wyFP: number): boolean {
            if (placing) {
                const [tileX, tileY] = placeOrigin(wxFP, wyFP, placing.fw, placing.fh);
                if (deps.canPlaceBuilding(tileX, tileY, placing.typeId)) {
                    deps.emit({ type: CmdType.BUILD, unitId: deps.consumeUnitId(),
                                typeId: placing.typeId, team: deps.myTeam, tileX, tileY });
                    disarm();   // placed — exit placement mode
                }
                // invalid spot: stay armed so the player can pick another tile
                return true;
            }
            if (armedId === null) return false;
            const id = armedId;
            disarm();
            if (id === "move") issueMove(wxFP, wyFP);
            else log(`${id}: targeting not yet implemented`);
            return true;
        },

        secondaryClick(wxFP: number, wyFP: number): void {
            if (armedId !== null || placing !== null) { disarm(); return; }  // abort targeting/placement
            issueMove(wxFP, wyFP);                                            // otherwise: smart move
        },

        escape(): void {
            disarm();
            if (page !== "root") { page = "root"; rerender(); }
        },

        isTargeting(): boolean { return armedId !== null || placing !== null; },
    };
}
