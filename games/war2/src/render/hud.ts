/**
 * HUD — wiring for the static DOM overlay declared in client.html (resource bar, portrait, command
 * card, collapsible tweak pane) plus the command-card view.  The layout itself is declarative HTML/CSS;
 * this module only grabs refs and attaches the few dynamic behaviours.  Split out of renderer.ts.
 */
import Phaser from "phaser";
import iconsUrl  from "../assets/graphics/tilesets/winter/icons.png";
import iconsJson from "../assets/icons.json";
import type { CommandCard } from "../game/abilities";

// Icon sheet geometry: 46×38 frames in a 5-column grid (icons.png is 230 wide).
const ICON_W = (iconsJson as any).frameWidth  as number;   // 46
const ICON_H = (iconsJson as any).frameHeight as number;   // 38
const ICON_COLS = 5;
const ICON_FRAMES = (iconsJson as any).frames as Record<string, number>;

/** CSS background-position that crops icons.png to the given icon-frame key. */
function iconBgPos(iconKey: string): string {
    const idx = ICON_FRAMES[iconKey] ?? 0;
    const col = idx % ICON_COLS, row = Math.floor(idx / ICON_COLS);
    return `-${col * ICON_W}px -${row * ICON_H}px`;
}

/** Grab refs into the static HUD markup (client.html) and attach the few
 *  dynamic behaviours: the tweak-panel toggle, the right-click guard, and the
 *  list of chrome panels flipped click-through during a drag-select.  The
 *  layout itself is entirely declarative HTML/CSS. */
export function wireHud(scene: Phaser.Scene): void {
    scene.resourceCell = document.querySelector<HTMLDivElement>("#hud-resources")!;
    scene.portraitCell = document.querySelector<HTMLDivElement>("#hud-portrait")!;
    scene.cardEl       = document.querySelector<HTMLDivElement>("#hud-card")!;
    scene.tweakPaneEl  = document.querySelector<HTMLDivElement>("#hud-tweak")!;
    scene.tweakBodyEl  = document.querySelector<HTMLDivElement>("#hud-tweak-body")!;

    // Chrome panels capture pointer events; flipped click-through during a drag.
    scene.interactiveCells = Array.from(
        document.querySelectorAll<HTMLDivElement>(".hud-chrome"),
    );

    // Right-click on the chrome shouldn't pop the browser context menu.
    document.querySelector("#hud")!
        .addEventListener("contextmenu", e => e.preventDefault());

    // Tweak-panel toggle (collapsed by default; .open is added/removed here).
    scene.tweakPaneEl.querySelector(".hud-tweak-handle")!
        .addEventListener("click", () => setTweakOpen(scene, !scene.tweakOpen));
}

/** Show/hide the tweak pane — CSS animates the width (and shrinks the frame). */
function setTweakOpen(scene: Phaser.Scene, open: boolean): void {
    scene.tweakOpen = open;
    scene.tweakPaneEl.classList.toggle("open", open);
    (scene.tweakPaneEl.firstElementChild as HTMLElement).textContent = open ? "›" : "‹";
}

/** Enter/leave drag-select mode.  While dragging, the perimeter cells stop
 *  capturing pointer events so the drag keeps tracking across them (Phaser
 *  owns the pointer from pointerdown, but a cell with pointer-events:auto
 *  would otherwise intercept the moves and freeze the rect at its edge). */
export function setHudDragMode(scene: Phaser.Scene, on: boolean): void {
    for (const c of scene.interactiveCells) c.style.pointerEvents = on ? "none" : "auto";
    if (!on) scene.cardEl.style.opacity = "1";   // restore the card fade
}

/** Draw a pre-computed command card (null = hide).  Slot clicks emit onSlot. */
export function showCommandCard(scene: Phaser.Scene, card: CommandCard | null): void {
    const el = scene.cardEl;
    el.replaceChildren();
    if (!card) { el.style.display = "none"; return; }
    el.style.display = "grid";

    card.forEach((ability, index) => {
        const cell = document.createElement("div");
        Object.assign(cell.style, {
            width: `${ICON_W}px`, height: `${ICON_H}px`,
            position: "relative", boxSizing: "border-box",
        });
        if (ability) {
            Object.assign(cell.style, {
                backgroundImage: `url(${iconsUrl})`,
                backgroundPosition: iconBgPos(ability.icon),
                backgroundRepeat: "no-repeat",
                imageRendering: "pixelated",
                border: "1px solid #2a4", cursor: "pointer",
            });
            cell.title = ability.hotkey.length === 1
                ? `${ability.label} (${ability.hotkey})` : ability.label;
            if (ability.hotkey.length === 1) {
                const k = document.createElement("span");
                k.textContent = ability.hotkey;
                Object.assign(k.style, {
                    position: "absolute", left: "1px", bottom: "0px",
                    font: "bold 10px monospace", color: "#ff4",
                    textShadow: "0 0 2px #000, 0 0 2px #000", pointerEvents: "none",
                });
                cell.appendChild(k);
            }
            cell.addEventListener("click", () => scene.onSlot?.(index));
        } else {
            cell.style.border = "1px solid rgba(255,255,255,0.10)";
            cell.style.background = "rgba(0,0,0,0.25)";
        }
        el.appendChild(cell);
    });
}
