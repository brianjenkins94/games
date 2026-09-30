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
- **Virtual network** (`network.ts`): in-memory hub links (hub's `pipe`) on a simulated clock with seeded drops,
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

One consequence: a client's hub id must be the id its link assigns, or its RPC replies can't reach it. Whoever creates
the client (the page, for an iframe) tells it its id.

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

The client tools reach a client over its `netsim.<match>.debug.<peer>.*` subjects, which its link permits only when
the page starts the referee with a `debugHost` — and then only the page may call them (`debugPermissions`): no client
can call another's, see those calls, or answer anyone but the page.

## Test

```bash
npm test
```

Two suites, both on `node:test` with type stripping (no build step):

- `test:node` — the sim and the network, in one process over the virtual network, with coverage thresholds (95%
  lines and functions, 90% branches) enforced.
- `test:browser` — the real runtime in headless Chromium: the page, the referee worker, the instance iframes and
  their client workers, observability, input and the page's MCP tools. It builds netsim and serves the build under
  the base Pages uses; `NETSIM_URL=http://localhost:5180/` runs it against a dev server instead. It needs a
  Chromium: Playwright's own, the system Chrome, or `CHROME_PATH`. `debug-mcp.test.ts` runs a real debug-mcp
  in-process and relays the page's link to it, so the page tools are tested the way an agent uses them: registered
  live, called over MCP.
