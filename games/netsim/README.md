# netsim

A minimal, war2-shaped simulation + network harness. It exists to prove that the editor's stack
(`@brianjenkins94/hub`, `observability`, `debug-mcp`) covers everything war2 needs — multiple game instances
talking to each other, fully observable and tested — before war2 itself moves onto it.

## Milestones

- **M0 — sim core** (here): a deterministic, fixed-point, instance-scoped sim with snapshot/restore and hashing.
- **M1** — a host-authoritative referee and N clients in one process over hub links: fog-filtered deltas and
  keyframes, prediction, command validation, fault injection.
- **M2** — the browser: a page, N instance iframes and sim workers, observability, game-specific debug-mcp tools.
- **M3** — the same project run inside the editor.
- **M4** — players in separate tabs (and separate editor preview windows) playing one match, every client linked to
  the referee over WebRTC; signaling across machines (a relay, or a copy-paste invite) next.

## The sim (`src/sim`)

- **Instances, not globals.** All state lives on the `World` object, so any number of worlds run side by side in
  one realm (the test suite steps two interleaved to prove it).
- **Integers only.** Positions are fixed-point (`FP = 1000` per tile); movement and vision share one integer
  distance metric; the RNG is a seeded xorshift32 whose state rides the world.
- **One field list.** `UNIT_FIELDS` is the single definition of a unit: snapshot, restore and both hashes enumerate
  it, so a field can't be added and silently left out of any of them.
- **Untrusted commands.** `validateCommand` takes `unknown` (it will come off the wire) and checks shape, integer
  values, bounds and ownership; it never throws.
- **Replayable.** `advance(world, log)` is the one definition of play: restoring a snapshot and replaying the same
  log reproduces continuous play exactly.

## The network (`src/net`)

- **Referee** (`referee.ts`): the one authoritative world. Seats clients over hub RPC, takes numbered command batches
  strictly in order, and each tick sends every team only what it can see — keyframes or deltas, each with a hash of
  the team's whole visible set.
- **Client** (`client.ts`): applies a delta only on top of the update it was built against (anything missing, late or
  duplicated triggers a keyframe request), checks every view against the referee's hash, predicts its own units, and
  resends command batches until they're acknowledged.
- **Virtual network** (hub's `createNetwork`): in-memory hub links (hub's `pipe`) on a simulated clock with seeded drops,
  duplicates and jitter on game traffic (told apart with hub's `frameOf`), so a whole match runs in one process,
  deterministically.

### Who can see and say what

A client is its hub id. The hub it links to assigns that id (`LinkOptions.peer`) and stamps it as `from` on
everything the client sends, so a client can't speak for another — the referee attributes commands by `from`.

That hub also confines the client with link permissions: until it's seated, `lobbyPermissions` (ask to join, hear its
own replies); once seated, `seatPermissions` (send commands, receive its own team's state). The referee publishes
every team's view, and the hub forwards each client only its own — even if it subscribes to all of them — so fog of
war holds against a hostile client, and no one can snoop another's RPC replies (which carry its seat token).

A client that loses its link (a reloaded instance) rejoins with the seat token its first join returned: it gets its
seat back, a keyframe, and the seat's next command number (`nextSeq`), so its commands carry on in sequence. In the
browser the instance keeps the token in `sessionStorage`, per match, and the page brokers a fresh channel on every
load of an instance.

Nobody tells a client worker its id: the hub that assigns it (the referee's) says so in its `hello`, and the client
names its subjects, logs and reports by it — and its RPC replies come back under it, the only reply subject its link
lets through. (The page still names its own instance frames — it's the page that assigns the ids at the referee.)

### Debugging a live match

With debugging on (localhost, or `?debug`), the page serves its own MCP tools, which a running debug-mcp registers as
real tools while the tab is connected (`src/browser/tools.ts`):

- `netsim_status` — the referee's tick, pause state and stats; every client's sync state (in sync, behind, OUT OF
  SYNC, joining, or stalled — no report for over a second).
- `netsim_state` — the authoritative world, and per client what it sees and predicts.
- `netsim_divergence` — each client's view against what the referee says its team can see, unit by unit. Exact at
  the same tick, so pause first.
- `netsim_control` — pause, resume, or step the referee N ticks.
- `netsim_command` — issue a command as a client, exactly as its player would.

They're also callable from the page itself: `await __netsim.tool("netsim_divergence")`. Run in the editor's preview
(`vite` in `games/netsim`), netsim joins the editor's hub tree instead of linking a debug-mcp itself: its logs and
architecture show in the editor, and the editor's debug-mcp serves these tools.

The client tools reach a client over its `netsim.<match>.debug.<peer>.*` subjects, from its own tab only: the client
worker takes debug calls on its page link alone (`client.worker.ts`), and its referee link (`hostPermissions`) carries
the game and nothing else — no client can call another's, see those calls, or answer anyone but its own page.

## Players in separate tabs (`play.html`)

`index.html` is the harness: one tab, one referee, N instance iframes. `play.html?match=<id>` is a match between
tabs: the first tab at a match hosts it (the referee, and its own player, `player-0`); every tab of the same origin
that opens that match after it joins as the next player (`player-1`, `player-2`, …). The page's "open another player"
link opens one: another tab on the same server, as on any desktop — in the editor, another preview window onto the
same server.

The lobby (`src/browser/lobby.ts`) is scoped to the origin — one server — not to a URL, so tabs meet whatever page
or path they were loaded from:

- **Who hosts** is a Web Lock per match: the first tab to take it hosts; the browser releases it when that tab goes,
  which is also how its players learn the host left.
- **Who's who** is a Web Lock per player id, held for the tab's life: a reloaded tab takes its old id back if it's
  free (and its seat, with the seat token it kept).
- **Introductions and signaling** ride a BroadcastChannel per match: a player's instance asks for a link under a fresh
  id, the host accepts, and the two pages trade the link's WebRTC offer, answer and candidates over the same channel.

Every client — in the host's own tab or another — links the referee over a WebRTC data channel (`src/browser/rtc.ts`).
Each end's page makes its peer connection and hands the data channel straight to its worker (a channel can be
transferred as it's created; a worker can't make a peer connection), so the game runs worker to worker and the pages
only signal: in memory within a page, over the lobby between tabs. The referee's side of each link is heartbeat-checked
and bounded (hub's `heartbeatMs`, `maxPayload`, `maxBacklog`); a player's tab going closes its data channel, and the
referee lets it go at once.

Each tab is its own hub tree, observed on its own (its own tab in debug-mcp). A player's client worker belongs to
both trees and joins neither to the other: both of its links are non-transit, the referee doesn't take a remote
client's observability (`PeerOptions.observed`), and the client confines what the host may send it to the game
(`hostPermissions`). The host's tools cover the whole match — every player's client included, when debugging is on
at both ends.

## Test

```bash
npm test
```

Two suites, both on `node:test` with type stripping (no build step):

- `test:node` — the sim and the network, in one process over the virtual network, with coverage thresholds (95%
  lines and functions, 90% branches) enforced.
- `test:browser` — the real runtime in headless Chromium: the page, the referee worker, the instance iframes and
  their client workers, observability, input and the page's MCP tools; and (`play.test.ts`) a match across tabs. It builds netsim and serves the build under
  the base Pages uses; `NETSIM_URL=http://localhost:5180/` runs it against a dev server instead. It needs a
  Chromium: Playwright's own, the system Chrome, or `CHROME_PATH`. `debug-mcp.test.ts` runs a real debug-mcp
  in-process and relays the page's link to it, so the page tools are tested the way an agent uses them: registered
  live, called over MCP.
