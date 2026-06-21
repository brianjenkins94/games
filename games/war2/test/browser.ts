/**
 * Ensure a war2 host is running for the e2e suite, via the shared @brianjenkins94/util/playwright
 * `attach` (connect to a browser over CDP :9222, auto-launching one if none is there) — same helper
 * the rest of the toolkit uses.
 *
 * If a host referee is already connected to the debug server (war2 open in your dev browser), this
 * does nothing and the suite drives that one — so the attach path only triggers when nothing's open.
 * `npm run dev` must be running either way.
 *
 * Returns a handle to undo what we opened (null when an existing host was reused).
 */
import { attach } from "@brianjenkins94/util/playwright/index";
import { type Inspector } from "./ws";

const WAR2_URL = "http://localhost:5173/";

export async function ensureWar2(insp: Inspector): Promise<{ close: () => Promise<void> } | null> {
    if ((await insp.query("status")).connected?.host) return null;   // already up — drive it

    const { browser, contexts } = await attach();   // CDP :9222 (launches a browser if needed)
    const ctx = contexts[0] ?? (await browser.newContext());
    const page = ctx.pages().find((p) => p.url().startsWith(WAR2_URL)) ?? (await ctx.newPage());
    if (!page.url().startsWith(WAR2_URL)) await page.goto(WAR2_URL);
    return { close: async () => { await browser.close(); } };   // CDP close() only disconnects
}
