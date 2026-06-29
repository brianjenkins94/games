/**
 * Command-card controller — the single owner of command-card interaction state.
 *
 * The card's modal behaviour is a *navigation stack*, like `history.pushState`:
 * opening a submenu or arming an action pushes a frame; Escape / the Cancel
 * button pops exactly one frame (the back button).  This makes "the same key
 * means different things at different depths" fall out for free — a hotkey is
 * just a click on whichever slot owns that letter in the *current* card.
 *
 *   Frame kinds (only `menu` frames nest; a transient sits on top of one):
 *     • menu      — a card page: "root", "build", …          (pushState)
 *     • targeting — a Move/Attack/etc. awaiting a target click (modal, on top)
 *     • placement — a building ghost following the cursor      (modal, on top)
 *
 *   stack[0] is always the "root" menu.  At most one transient exists, always
 *   on top; arming a new action *replaces* it (replaceState) rather than
 *   nesting.  The displayed card is always the topmost MENU frame's page, so
 *   targeting/placement leave the menu visible (matching WC2/StarCraft).
 *
 * Navigation that matches WC2/StarCraft:
 *   • Escape / Cancel  → back() — pop one level (placement → build → root).
 *   • Right-click      → cancel a transient, else issue a smart move; it never
 *                        unwinds menus.
 *   • A letter hotkey  → identical to clicking that slot in the current card.
 *
 * Determinism boundary: this is client intent only.  It never mutates the sim —
 * it computes cards (pure `commandCardFor`) and emits `Command`s via `emit`,
 * exactly like a right-click move.  Targeting/placement live on the render side.
 *
 * Only abilities whose sim systems exist today are fully wired (Move→MOVE,
 * Stop→STOP, Build→BUILD).  Everything else is recognised and logged.
 */
import { commandCardFor, type CommandCard } from "../game/abilities";
import { CmdType, type Command } from "../net/protocol";
import { unitTypeId, unitFootprint } from "../game/unitTypes";

/** A pending building placement (ghost following the cursor). */
export interface PlacementGhost {
    tileX: number; tileY: number; fw: number; fh: number; valid: boolean;
}

export interface CardControllerDeps {
    /** Stable unit-ids of the player's own currently-selected units. */
    getOwnSelection: () => number[];
    /** Uid of the selected building if a single production-capable building is selected (else undefined)
     *  — when set, a right-click sets its rally point rather than issuing a move. */
    getRallyableBuildingUid?: () => number | undefined;
    /** Snap an FP world coordinate to its tile centre. */
    snapToTile: (fp: number) => number;
    /** Hand a finalized command to the sim worker. */
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
    /** A letter key was pressed — dispatch to the matching slot in the current
     *  card.  Returns true if a slot owned that hotkey (i.e. it was consumed). */
    hotkey(letter: string): boolean;
    /** Cursor moved over the map — updates the placement ghost (no-op otherwise). */
    hoverTile(wxFP: number, wyFP: number): void;
    /** Left-click on the map. Returns true if consumed by an armed ability. */
    primaryClick(wxFP: number, wyFP: number): boolean;
    /** Right-click on the map: cancel an armed ability, set a selected building's rally, else issue a
     *  move (shift = append to the action queue). */
    secondaryClick(wxFP: number, wyFP: number, shift?: boolean): void;
    /** Escape: go back one navigation level (transient → menu → root). */
    escape(): void;
    /** True while an ability is armed and waiting for a target click. */
    isTargeting(): boolean;
}

// ── Navigation frames ────────────────────────────────────────────────────────────

type Frame =
    | { kind: "menu";      page: string }
    | { kind: "targeting"; abilityId: string }
    | { kind: "placement"; typeId: number; fw: number; fh: number };

export function createCommandCardController(deps: CardControllerDeps): CommandCardController {
    let type: string | null = null;
    // Invariant: stack[0] is always the root menu; a transient (targeting/placement)
    // only ever sits on top, and there is at most one.
    let stack: Frame[] = [{ kind: "menu", page: "root" }];

    const log = (m: string) => deps.log?.(m);

    /** The transient frame on top, if any (targeting / placement). */
    function transient(): Extract<Frame, { kind: "targeting" | "placement" }> | null {
        const top = stack[stack.length - 1];
        return top.kind === "menu" ? null : top;
    }
    /** Page of the topmost MENU frame — what the card actually shows. */
    function activePage(): string {
        for (let i = stack.length - 1; i >= 0; i--)
            if (stack[i].kind === "menu") return (stack[i] as { page: string }).page;
        return "root";  // unreachable: stack[0] is always a menu
    }
    function currentCard(): CommandCard | null {
        return type ? commandCardFor(type, activePage()) : null;
    }
    function rerender(): void { deps.render(currentCard()); }

    /** Pop a transient frame if one is on top; clears cursor + ghost. Returns
     *  whether one was dropped.  Does NOT re-render (the menu beneath is
     *  unchanged — only the cursor/ghost differ). */
    function dropTransient(): boolean {
        if (!transient()) return false;
        stack.pop();
        deps.setTargetingCursor?.(false);
        deps.showPlacementGhost?.(null);
        return true;
    }

    /** Go back one level: drop a transient, else pop one menu page. */
    function back(): void {
        if (dropTransient()) return;            // transient → back to its menu
        if (stack.length > 1) { stack.pop(); rerender(); }  // submenu → parent
    }

    /** Footprint top-left for a building centred under the cursor. */
    function placeOrigin(wxFP: number, wyFP: number, fw: number, fh: number): [number, number] {
        return [deps.fpToTile(wxFP) - (fw >> 1), deps.fpToTile(wyFP) - (fh >> 1)];
    }

    function issueMove(txFP: number, tyFP: number, queue = false): void {
        const sel = deps.getOwnSelection();
        if (!sel.length) return;
        const sx = deps.snapToTile(txFP), sy = deps.snapToTile(tyFP);
        deps.emit({ type: CmdType.MOVE, unitIds: sel, txFP: sx, tyFP: sy, ...(queue ? { queue: true } : {}) });
    }
    function issueStop(): void {
        const sel = deps.getOwnSelection();
        if (sel.length) deps.emit({ type: CmdType.STOP, unitIds: sel });
    }

    return {
        setSelection(unitType: string | null): void {
            type = unitType;
            stack = [{ kind: "menu", page: "root" }];
            deps.setTargetingCursor?.(false);
            deps.showPlacementGhost?.(null);
            rerender();
        },

        slot(index: number): void {
            const ability = currentCard()?.[index];
            if (!ability) return;
            const it = ability.interaction;
            switch (it.kind) {
                case "submenu":
                    dropTransient();
                    stack.push({ kind: "menu", page: it.page });
                    rerender();
                    break;
                case "cancel":
                    back();
                    break;
                case "immediate":
                    dropTransient();
                    if (ability.id === "stop") issueStop();
                    else log(`${ability.id}: not yet implemented`);
                    break;
                case "targetGround":
                case "targetUnit":
                    // Arming replaces any active transient (replaceState).
                    dropTransient();
                    stack.push({ kind: "targeting", abilityId: ability.id });
                    deps.setTargetingCursor?.(true);
                    break;
                case "placement": {
                    dropTransient();
                    const typeId = unitTypeId(it.building);
                    const [fw, fh] = unitFootprint(typeId);
                    stack.push({ kind: "placement", typeId, fw, fh });
                    deps.setTargetingCursor?.(true);
                    break;
                }
                case "produce": {
                    // Enqueue a unit at the selected building (research/upgrades fall through harmlessly:
                    // the referee only accepts products the building actually trains).
                    dropTransient();
                    const buildingUid = deps.getOwnSelection()[0];
                    if (buildingUid !== undefined) {
                        deps.emit({ type: CmdType.PRODUCE, buildingUid, productTypeId: unitTypeId(it.product), team: deps.myTeam });
                    }
                    break;
                }
            }
        },

        hotkey(letter: string): boolean {
            const card = currentCard();
            if (!card) return false;
            const L = letter.toUpperCase();
            const idx = card.findIndex(a => a !== null && a.hotkey.length === 1 &&
                                            a.hotkey.toUpperCase() === L);
            if (idx < 0) return false;
            this.slot(idx);
            return true;
        },

        hoverTile(wxFP: number, wyFP: number): void {
            const t = transient();
            if (t?.kind !== "placement") return;
            const [tileX, tileY] = placeOrigin(wxFP, wyFP, t.fw, t.fh);
            deps.showPlacementGhost?.({
                tileX, tileY, fw: t.fw, fh: t.fh,
                valid: deps.canPlaceBuilding(tileX, tileY, t.typeId),
            });
        },

        primaryClick(wxFP: number, wyFP: number): boolean {
            const t = transient();
            if (t?.kind === "placement") {
                const [tileX, tileY] = placeOrigin(wxFP, wyFP, t.fw, t.fh);
                if (deps.canPlaceBuilding(tileX, tileY, t.typeId)) {
                    deps.emit({ type: CmdType.BUILD, typeId: t.typeId, team: deps.myTeam, tileX, tileY });
                    dropTransient();   // placed — back to the build menu (referee mints the id)
                }
                // invalid spot: stay armed so the player can pick another tile
                return true;
            }
            if (t?.kind === "targeting") {
                const id = t.abilityId;
                dropTransient();
                if (id === "move") issueMove(wxFP, wyFP);
                else log(`${id}: targeting not yet implemented`);
                return true;
            }
            return false;
        },

        secondaryClick(wxFP: number, wyFP: number, shift = false): void {
            if (dropTransient()) return;   // abort targeting/placement
            // A selected production building: right-click sets its rally point instead of moving.
            const rallyBuilding = deps.getRallyableBuildingUid?.();
            if (rallyBuilding !== undefined) {
                deps.emit({ type: CmdType.SET_RALLY, buildingUid: rallyBuilding,
                            txFP: deps.snapToTile(wxFP), tyFP: deps.snapToTile(wyFP), team: deps.myTeam });
                return;
            }
            issueMove(wxFP, wyFP, shift);   // otherwise: smart move (shift = queue/append)
        },

        escape(): void { back(); },

        isTargeting(): boolean { return transient() !== null; },
    };
}
