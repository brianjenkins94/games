/**
 * The harness page: hosts a match with one instance iframe per client, all in this tab (`?clients=3&teams=3&seed=1…`).
 * For players in separate tabs, see play.ts.
 */
import { readSettings } from "./bootstrap.ts";
import { startHost } from "./host.ts";

const settings = readSettings(location.search);
const host = startHost({
	"settings": settings,
	"matchId": crypto.randomUUID().slice(0, 8),
	"grid": document.querySelector<HTMLElement>("#instances")!,
	"status": document.querySelector<HTMLTableSectionElement>("#status tbody")!,
	"summary": document.querySelector<HTMLElement>("#summary")!
});

for (let index = 0; index < settings.clients; index += 1) {
	host.addInstance(`client-${index}`);
}
