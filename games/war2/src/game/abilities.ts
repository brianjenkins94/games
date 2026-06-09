/**
 * Command-card ability data layer.
 *
 * `commandCardFor(unitType, page)` returns the 9-slot command grid for a given
 * selected unit/building, assembled from the existing game data:
 *   • units.json       — capabilities (speed → can move, canAttack → can attack)
 *   • production.json   — what the unit builds / trains / researches / casts
 *   • upgrades.json     — research icons
 *   • icons.json        — icon-frame keys
 *   • factions.json     — human/orc faction (icons are faction-specific)
 *
 * This is PURE, CLIENT-SIDE UI data — it never touches the sim and has no
 * determinism constraints.  The command-card controller (commandCardController.ts) interprets the
 * returned abilities' `interaction` to drive targeting/placement and ultimately
 * emit a sim Command.  Nothing here mutates state.
 *
 * Slot/hotkey assignments are "sensible defaults" pending an exact-WC2 pass.
 */
import unitsJson      from "../assets/units.json";
import productionJson from "../assets/production.json";
import upgradesJson   from "../assets/upgrades.json";
import factionsJson   from "../assets/factions.json";
import iconsJson      from "../assets/icons.json";

// ── Types ──────────────────────────────────────────────────────────────────────

/** How the player interacts with an ability after pressing it. */
export type Interaction =
    | { kind: "immediate" }                       // Stop / Hold — fire the command now
    | { kind: "targetGround" }                    // Move / Patrol / ground-target spell
    | { kind: "targetUnit" }                      // Attack / unit-target spell
    | { kind: "placement"; building: string }     // Build — ghost follows cursor, click places
    | { kind: "produce";   product: string }      // Train unit / research upgrade at this building
    | { kind: "submenu";   page: string }         // Open a sub-page (e.g. the build list)
    | { kind: "cancel" };                         // Back out of a sub-page

export interface Ability {
    /** Stable id, e.g. "move", "build:unit-farm", "train:unit-footman". */
    id: string;
    /** Short human label for tooltips. */
    label: string;
    /** icon-frame key from icons.json (placeholder if no dedicated art exists). */
    icon: string;
    /** Single uppercase hotkey letter. */
    hotkey: string;
    interaction: Interaction;
}

/** Fixed 9-slot grid (3×3, row-major). null = empty slot. */
export type CommandCard = (Ability | null)[];

export const CARD_SLOTS = 9;
/** Icon used when no dedicated art exists yet (Stop, spells, a few buildings). */
const PLACEHOLDER_ICON = "icon-cancel";

// ── Data access ────────────────────────────────────────────────────────────────

type Rec = Record<string, any>;
const UNITS      = unitsJson      as Rec;
const PRODUCTION = productionJson as Rec;
const UPGRADES   = upgradesJson   as Rec;
const ICON_FRAMES = (iconsJson as Rec)["frames"] as Record<string, number>;

const ORC_TYPES = new Set(Object.values((factionsJson as Rec)["humanToOrc"] as Record<string, string>));

function iconExists(key: string): boolean { return key in ICON_FRAMES; }

/** human / orc — orc if the type appears on the orc side of factions.json. */
export function factionOf(unitType: string): "human" | "orc" {
    return ORC_TYPES.has(unitType) ? "orc" : "human";
}

/** Best-effort portrait/build icon for a unit type: icon-<name>, else placeholder. */
function unitIcon(unitType: string): string {
    const key = "icon-" + unitType.slice("unit-".length);
    return iconExists(key) ? key : PLACEHOLDER_ICON;
}

/** Prettify a "unit-elven-lumber-mill" / "upgrade-sword1" key into a label. */
function labelFor(key: string): string {
    const name = (UPGRADES[key]?.name as string) ?? undefined;
    if (name) return name;
    return key.replace(/^(unit|upgrade|spell)-/, "")
              .split("-")
              .map(w => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" ");
}

// ── Faction-aware common-verb icons (sensible defaults) ──────────────────────────
// No generic Move/Stop/Attack art exists; we reuse the closest faction icon and
// fall back to the placeholder.  Refine in the exact-WC2 pass.

function verbIcon(faction: "human" | "orc", candidates: string[]): string {
    for (const c of candidates) if (iconExists(c)) return c;
    return PLACEHOLDER_ICON;
}

// ── Common ability builders ──────────────────────────────────────────────────────

function moveAbility(faction: "human" | "orc"): Ability {
    return { id: "move", label: "Move", hotkey: "M",
             icon: verbIcon(faction, [`icon-move-${faction === "orc" ? "peon" : "peasant"}`]),
             interaction: { kind: "targetGround" } };
}
function stopAbility(): Ability {
    return { id: "stop", label: "Stop", hotkey: "S",
             icon: PLACEHOLDER_ICON, interaction: { kind: "immediate" } };
}
function attackAbility(faction: "human" | "orc"): Ability {
    return { id: "attack", label: "Attack", hotkey: "A",
             icon: verbIcon(faction, [`icon-${faction}-attack-ground`]),
             interaction: { kind: "targetUnit" } };
}
function patrolAbility(faction: "human" | "orc"): Ability {
    return { id: "patrol", label: "Patrol", hotkey: "P",
             icon: verbIcon(faction, [`icon-${faction}-patrol-land`]),
             interaction: { kind: "targetGround" } };
}
function holdAbility(faction: "human" | "orc"): Ability {
    return { id: "hold", label: "Stand Ground", hotkey: "H",
             icon: verbIcon(faction, [`icon-${faction}-stand-ground`]),
             interaction: { kind: "immediate" } };
}
function repairAbility(): Ability {
    return { id: "repair", label: "Repair", hotkey: "R",
             icon: verbIcon("human", ["icon-repair"]), interaction: { kind: "targetUnit" } };
}
function buildAbility(page: string, advanced: boolean): Ability {
    return { id: advanced ? "build-advanced" : "build-basic",
             label: advanced ? "Build Advanced" : "Build Basic",
             hotkey: advanced ? "V" : "B",
             icon: advanced ? "icon-build-advanced" : "icon-build-basic",
             interaction: { kind: "submenu", page } };
}
function cancelAbility(): Ability {
    return { id: "cancel", label: "Cancel", hotkey: "Escape",
             icon: "icon-cancel", interaction: { kind: "cancel" } };
}

// ── Card assembly ────────────────────────────────────────────────────────────────

function emptyCard(): CommandCard { return new Array(CARD_SLOTS).fill(null); }

/**
 * Ensure every single-letter hotkey in a card is unique.  Walks slots in order;
 * if an ability's preferred letter is taken, it falls back to the next free
 * letter of its label, then any free A–Z.  Multi-key bindings (e.g. "Escape")
 * are left untouched.  Mutates and returns the card.
 */
function dedupeHotkeys(card: CommandCard): CommandCard {
    const used = new Set<string>();
    for (const a of card) {
        if (!a || a.hotkey.length !== 1) continue;
        const tried = (a.hotkey + a.label.toUpperCase().replace(/[^A-Z]/g, "") +
                       "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
        for (const ch of tried) {
            if (!used.has(ch)) { a.hotkey = ch; used.add(ch); break; }
        }
    }
    return card;
}

/**
 * Assemble the command card for a selected unit type on a given page.
 * `page` is "root" for the top-level card, or a submenu id (e.g. "build").
 */
export function commandCardFor(unitType: string, page: string = "root"): CommandCard {
    const def  = UNITS[unitType] ?? {};
    const prod = PRODUCTION[unitType] ?? {};
    const faction = factionOf(unitType);

    // ── Submenu pages ───────────────────────────────────────────────────────────
    if (page === "build") {
        const card = emptyCard();
        const builds: string[] = prod.builds ?? [];
        builds.slice(0, CARD_SLOTS - 1).forEach((b, i) => {
            card[i] = { id: `build:${b}`, label: labelFor(b), icon: unitIcon(b),
                        hotkey: labelFor(b).charAt(0).toUpperCase(),
                        interaction: { kind: "placement", building: b } };
        });
        card[CARD_SLOTS - 1] = cancelAbility();
        return dedupeHotkeys(card);
    }

    // ── Root page ─────────────────────────────────────────────────────────────────
    const card = emptyCard();
    const canMove   = typeof def.speed === "number" && def.speed > 0;
    const canAttack = def.canAttack === true;
    const canBuild  = Array.isArray(prod.builds) && prod.builds.length > 0;

    if (canMove) {
        card[0] = moveAbility(faction);
        card[1] = stopAbility();
    }
    if (canAttack) {
        card[2] = attackAbility(faction);
        card[3] = patrolAbility(faction);
        card[4] = holdAbility(faction);
    }
    if (canBuild) {
        card[5] = repairAbility();
        // All builds share one submenu for now; basic/advanced split is a data
        // tagging task for the exact-WC2 pass.
        card[6] = buildAbility("build", false);
    }

    // ── Buildings: train / research / upgrade-to (no movement) ───────────────────
    if (!canMove) {
        let slot = 0;
        const put = (a: Ability) => { if (slot < CARD_SLOTS) card[slot++] = a; };
        for (const u of (prod.trains ?? []) as string[])
            put({ id: `train:${u}`, label: labelFor(u), icon: unitIcon(u),
                  hotkey: labelFor(u).charAt(0).toUpperCase(),
                  interaction: { kind: "produce", product: u } });
        for (const up of (prod.researches ?? []) as string[])
            put({ id: `research:${up}`, label: labelFor(up),
                  icon: (UPGRADES[up]?.icon as string) ?? PLACEHOLDER_ICON,
                  hotkey: labelFor(up).charAt(0).toUpperCase(),
                  interaction: { kind: "produce", product: up } });
        for (const u of (prod.upgradesTo ?? []) as string[])
            put({ id: `upgrade:${u}`, label: labelFor(u), icon: unitIcon(u),
                  hotkey: labelFor(u).charAt(0).toUpperCase(),
                  interaction: { kind: "produce", product: u } });
    }

    return dedupeHotkeys(card);
}
