# war2 → games: inventory and migration plan

Written 2026-10-01, from a read of war2 as it sits in the iCloud monorepo
(`Code/games/games/war2`: no git, ~11.6k lines of code, 164 MB of assets, linked to `packages/{harness,metrics,vscode,
window,theme}`). The move is the chance to clean up and to revisit the architecture, so this plan does both: what to
carry, what to rebuild on the stack netsim proved, what to delete, and the decisions that are yours to make.

## Verdict

war2's value is its **game core**: the two-tier pathing (a cached terrain flow field plus an 8px local A* with
string-pulling), diamond collision, formations, order queues, buildings and production, fog, and a good Phaser renderer
on a complete data set. Almost everything **around** that core is either something netsim already does better, or
something the editor now provides:
- its netcode (PeerJS, unordered channel, no sequencing);
- its runtime shell (iframe "boxes", an embedded VS Code, pairing through the top page);
- its dev tooling (a bespoke debug server on :9229, a console relay over WebSockets).

So the move isn't "copy war2 over". It is **war2's core on netsim's skeleton**:
- carry the bitecs core and the pathing nearly verbatim, and fix the snapshot contract;
- adopt netsim's protocol and runtime, over PeerJS for finding players across machines;
- re-home the debug tools as page tools.

war2 is also reference material for the game maker (see "Shaped for the game maker"). The port keeps it in the house
style the game maker's recognizer reads: bitecs components as behaviors, systems as rules.

The July audit (war2's `REVIEW.md`) still holds almost everywhere. Of its findings, only ts-1 (the test suite importing
vitest) was fixed. The determinism holes, the untrusted-input holes and all seven rendering issues are still there.
Most of them disappear **by construction** in this plan rather than by patching.

## What's there

### Sim core (`src/game`)
- **State is module-level globals.** Fixed `CAP=4096` typed-array components (the usual bitecs idiom), plus a
  module-level uid map, RNG, passability, occupancy, walk grid, flow-field cache and vision.
  - `createSimWorld` resets them all, so **two worlds can't coexist in one realm**; it works only because the referee
    and client sit in separate workers.
  - Nothing guards the entity cap: past 4096, writes are silently dropped.
  - bitecs (0.4) supplies entity ids and queries, and is declared only in the monorepo root's `package.json`.
- **Tick order:** path obstacles → movement → order queues → construction → production → vision. Fixed-point
  FP=1000 with an integer dodecagon distance. The determinism discipline is good.
- **The hash covers only `Position`,** not even the uid, despite the docs. Tick, RNG, move targets, paths, orders and
  production all diverge unnoticed.
- **Snapshot holes, all still open:**
  - `Path.wp*` (the pinch-corridor state) isn't snapshotted, and isn't reset on spawn/despawn/new move either, so a
    recycled entity id inherits a stale corridor and mispaths **live**.
  - `world.lastMove` isn't snapshotted, and its signature is built from entity ids, which restore re-allocates.
- **Validation trusts the wire:** no finite or integer checks, no bounds on MOVE, no type checks on SPAWN/BUILD. A NaN
  `CANCEL_PRODUCE` index drops the head of the queue. SPEED bypasses validation and team checks entirely, and NaN
  pins the host's tick loop at 0 ms.
- **Unit type ids are the sorted keys of `units.json`,** so adding one unit renumbers every id. Movement uses a global
  speed and ignores each unit's `speed`.
- **Quality:**
  - The pathing core is clean. The audit found one real bug there, mv-1: the tier-2 slip uses `footprintStaticFreeAt`,
    so a mover oscillates against parked units forever. It's a one-line fix.
  - The tangle is concentrated: a ~225-line, 9-tier `stepUnit`; about six copies of a ring search in `orders.ts`; dead
    pre-map branches; `gatherSlots`, which nothing writes; `abilities.ts`, which is client UI living in the sim folder;
    and stale comments ("circle" collision that is actually a diamond, flow fields that "route around settled units"
    but don't).

### Runtime and netcode (`src/worker`, `src/net`, `src/client`)
- **Topology:**
  - The top page hosts two iframe "boxes" (almostnode virtual servers, host and peer) in detachable windows.
  - It also runs a metrics dashboard and an embedded VS Code workbench with a DAP bridge.
  - Each box opens a PeerJS peer (a local broker on :9000, or PeerJS cloud), and the top page relays the pairing.
- **The host plays in-process** over postMessage; only the guest uses the wire.
- **The data channel never actually reaches the guest's worker.** It's handed over in the connection's `open` callback,
  and Chromium accepts that hand-off only as the channel is created, so it always falls back to relaying every packet
  through the main thread (`client/main.ts`).
- **The wire:**
  - The channel is **unordered** (`reliable: false`), framed as 1-byte type + 4-byte length + JSON.
  - Commands carry no sequence number and no ack, so MOVE and STOP can arrive reordered.
  - Deltas carry no base tick, so a stale delta corrupts the guest's baseline until the next keyframe.
  - There's no view hash, so a desync can't be detected.
- **Unauthenticated messages:** the box's message handler checks neither origin nor source, and everything is posted
  with `"*"`.
- **What war2 has that netsim lacks:**
  - per-tick render IPC;
  - prediction with a full flow field and tiered snap tolerances;
  - host sim-restore (a snapshot heartbeat, so a reloaded host resumes);
  - a pathology detector with incident capture and replay;
  - a step / reverse-step / breakpoint debugger inside the referee;
  - scenario loading.

### Dev tooling (`tools/debug-server.mjs`, `src/debug`)
- One Node process on :9229, an HTTP MCP server plus a WebSocket hub, with about 30 tools:
  - read: state, unit, map, trace, summarize_move, …;
  - drive: pause, step, move, build, produce, load_scenario, …;
  - incidents: flag, list, get, replay, save_incident_test.
- **Push, uncapped:** the host pushes the whole ECS every tick into history that is never trimmed.
- **Dead half:** the guest never pushes state, so `get_diff`, `find_divergence` and every "peer" half always return
  empty.

### Rendering (`src/render`)
- **Well built:**
  - one Phaser 4 scene;
  - 16×16-tile chunked terrain render textures, streamed;
  - fog render textures rebuilt only when a chunk changes, with Stratagus-style fog edges;
  - a data-driven sprite registry;
  - a minimap and a DOM HUD.
  - It never touches the sim.
- **Fragile wiring:**
  - Phaser comes from an **unpinned** jsdelivr script tag.
  - It imports `util` by relative path.
  - Fog is computed twice: the referee filters by team, then the renderer recomputes visibility over the full map
    three times a frame.
- **All seven audit rendering issues are still present.** For example: scenario fog is clobbered every frame;
  drag-select rings enemies and hit-tests raw positions rather than drawn ones; the fog JSDoc describes code that
  isn't there.

### Assets
- **164 MB, of which about 7 MB is used:** all 458 graphics PNGs (loaded eagerly) and 2 of the 4 tilesets, but **one**
  of the 205 maps.
- **Unused:** all audio (about 137 MB of campaign voice, sounds and music), and 4 of the 12 metadata JSONs (sounds,
  missiles, spells, tileTypes).
- **Served from a public Pages mirror** (`brianjenkins94.github.io/assets/war2`) of the private `assets` repo.
  `postinstall.sh` wipes the subdirectories and re-downloads all 1,289 files on every install, with no checksums.
- **These are Blizzard's Warcraft II assets** (Wargus-style). The public mirror already makes "private" moot.

### Tests (`test/`)
- **Two modes:**
  - **in-process:** `CI=1`, through `createGame`;
  - **browser:** drives a live dev host over the debug server's WebSocket; needs the dev server, :9229 and a browser
    on CDP :9222.
- **Still open from the audit:**
  - The incident corpus is **empty**, so `pathing.incidents.test.ts` guards nothing.
  - The rally assertion passes for any movement.
  - A fixture with no `expect` asserts nothing.
  - The pathology guard (`assertQuiet`) is a no-op in-process, the only mode CI could run.
- **No CI has ever run these.**
- The "visual" tests are watchable runs, not screenshots.

## The architecture, reconsidered

| Question | war2 today | Recommendation |
|---|---|---|
| Who owns sim state | bitecs components as module-level arrays; recycled entity ids | **Keep bitecs and its component model.** It's integral to the game maker: components are behaviors, systems are rules (see "Shaped for the game maker"). Fix the recycled-id bugs inside bitecs: reset *every* per-entity field on spawn (`wp*` included, from the field registry), and key `lastMove` and every tie-break by the stable `UnitId`, never the eid. Guard the entity cap. **All sim state on the world** (decided in W2, when the match tests needed a referee and its clients' predictions in one process): bitecs 0.4 components hang off each world, as does everything else the sim keeps. Declare bitecs in war2's own `package.json`. |
| Snapshot, restore, hash | Hand-listed fields, some missing; hash = positions | **One field list per bitecs component** drives all three, plus the spawn reset (netsim's `UNIT_FIELDS`, applied to components). The hash covers every sim field plus tick, RNG and queues, so restore + replay == continuous becomes a cheap property test. |
| Unit type ids | Sorted `units.json` keys | An explicit, stable table (or names on the wire). Read each unit's own `speed`. |
| Finding players, connecting | PeerJS (a local broker on :9000 in dev, PeerJS cloud when deployed); the top page relays pairing | **Keep PeerJS** for discovery and the connection across machines, the piece netsim doesn't have yet. It needs no servers of ours: PeerJS cloud brokers signaling, and its defaults (1.5.5) include Google STUN and PeerJS's own TURN relays (`eu-0`/`us-0.turn.peerjs.com`), so testers behind NATs that block direct connections still connect, relayed. It's free and shared, with no uptime guarantee: fine for playtesting; a shipped game would swap in its own signaling and TURN behind the same seam. Two fixes:<br>• open the channel **reliable and ordered** (hub's transport contract; war2 opens it `reliable: false`);<br>• **hand the data channel to the worker as it's created.** On the dialing side, `peer.connect()` creates it synchronously. On the answering side, listen for the peer connection's `datachannel` event from within `peer.on("connection")`. Verified in W2 (`test/browser/peerjs.test.ts`).<br>Pairing comes from the lobby and PeerJS ids, not the top page. netsim's `Signaling` seam could reuse PeerJS for its own cross-machine gap. |
| Protocol over the connection | Unordered, unsequenced, no base tick, no view hash, host in-process | **netsim's protocol and runtime:** sequenced, acked command batches; `baseTick` deltas with view hashes; fog enforced by hub permissions; hub links over `dataChannelTransport`. Fixes the stale-delta, malformed-packet and false-ordering-comment findings by construction. |
| The host's own player | In-process `LocalRefereeClient` | **A client worker like any other** (netsim's model), linked over a data channel or a MessageChannel. One code path for prediction, interpolation and render state. |
| Game speed | A guest-sendable command | A **referee RPC only the host may call.** |
| Validation | Casts, no finite or bounds checks | netsim's `validateCommand(unknown)`: exhaustive per command (integer, finite, bounds, type class, ownership), returning a typed rejection. Client-issued SPAWN goes. |
| Fog | Computed in the referee and again in the renderer | Computed **once, in the client worker**, and sent with the render state, with a `revealAll` flag for scenarios. Fixes the scenario-fog bug structurally. |
| Renderer | Phaser from a CDN, fed per tick over postMessage | **Keep Phaser 4, bundled and pinned.** `RenderState`/`RenderUnit` become the hub message schema from client worker to page. Pure functions pulled out so they can be node-tested (selection, frames, fog index, interpolation). |
| Dev tooling | A bespoke :9229 server, push, WebSocket console relay | **observability + debug-mcp.** Logs and architecture come free from `observe()`. war2's own tools become **page tools** backed by **pull**: history rings in the referee, queried by RPC. `save_incident_test` returns fixture JSON for the agent to write. Divergence becomes netsim's view-hash check. |
| Runtime shell | Iframe boxes, detachable windows, embedded VS Code | **Gone.** netsim's pages, instances, lobby and `rtc.ts` replace the boxes. Editor preview windows replace pop-out. The editor *is* the workbench. |
| Host restore | Snapshot heartbeat into the top page | **Later.** For now a match ends when its host leaves (as in netsim). Revisit once snapshots are complete: the host page keeps the latest snapshot, and a reloaded host re-takes the lobby's host lock and restores it. |
| Step debugger | Breakpoints, data breakpoints and reverse-step inside the referee | **Retired.** The editor's debugger replaces it. |
| TypeScript | `strict: false` | **Keep the relaxed defaults** (the games repo's tsconfig). |

## Carry, rebuild, delete

- **Carry nearly verbatim:**
  - the bitecs components and systems, including `systems/commands.ts`'s `CmdType`→handler switch, the mature
    command→action layer;
  - the pathing: `flowField`, `localPath`, `walkGrid` collision, `distance`, `pathObstacles`, and the formation and
    gather logic in `orders`;
  - PeerJS, with the two fixes above;
  - the incident detector;
  - the scenario fixtures (`test/fixtures.ts`) and the dual-mode `Driver` interface;
  - `commandCardController` (pure);
  - the renderer modules.

  Apply the mv-1 one-liner, factor the ring searches into one helper, and fix stale comments file by file as each moves.
- **Rebuild on netsim's shape:**
  - snapshot, restore, hash and the spawn reset, driven by the component field lists;
  - validation;
  - referee and client (prediction moved into netsim's client shape);
  - the page, instance and lobby layer, with PeerJS behind the connection;
  - the test harness (netsim's `serveBuild` + `launchChromium`, driving through page tools, so the pathology guard runs
    in CI).
- **Delete:**
  - the top page's pairing relay (PeerJS stays, as above);
  - the `harness`, `window`, `theme` and `vscode` packages, and the workbench half of `index.tsx`;
  - the almostnode, cross-origin-isolation and Preact-dedupe Vite plugins;
  - `tools/debug-server.mjs` and `tools/diff.mjs`;
  - the WebSocket console relay (`debug/socket.ts`, the worker console, log formatting, metrics forwarding, the console
    overlay);
  - the main-thread relay fallback (once the hand-off at creation works);
  - `net/transport.ts` and the `protocol.ts` framing;
  - `swapHost`;
  - the referee's step debugger (breakpoints, data breakpoints, reverse-step), in favour of the editor's debugger;
  - `gatherSlots`;
  - the pre-map mode, `spawnRandom` and `WORLD_W/H`;
  - display-only enemies as sim entities (the client holds a predicted world plus a view, as in netsim);
  - `abilities.ts` from the sim (it moves to the client);
  - the eager glob of every PNG.
- **Optional:** the metrics package; a page tool or structured logs cover it.

## Shaped for the game maker

war2 is one of the two reference games for the game maker's recognizer (the other is dozer). The recognizer reads
code back into the event sheet, and is built for one house style: bitecs + Phaser. So the port keeps war2 inside that
style, and cleans up toward it:
- **Components are behaviors.** Keep war2's bitecs components as the traits a kid would recognise (Position, Unit,
  Building, MoveTarget, …). Don't hide them behind an OOP layer.
- **Systems are rules.** Each system queries components and acts on the matches, so it reads as "for each «object
  type»". When a system is a long ladder (the ~225-line, 9-tier `stepUnit`), split it into named steps rather than
  growing it.
- **The command layer stays explicit:** `CmdType`→handler is already the event→action shape.
- **The engine folds into named behaviors.** Pathfinding, the flow field and vision are behaviors the sheet steps over,
  not custom code it tries to decompose. Keep them behind clear, named entry points.
- **Content stays data:** `units.json`, `production.json` and friends, with a stable type table.

## Milestones

Slow and deliberate, the way netsim was built. Each milestone ends green in CI, with GAPS updated.

- **W0: an oracle, before anything moves.** *Done (2026-10-01).*
  - The old sim core is frozen in `legacy/` (`src/game`, `src/net/protocol.ts`, the asset JSON it reads, and *Plains of
    snow BNE*). It runs under tsx because of its `const enum`s. It's deleted once nothing needs the old sim's traces
    re-recorded.
  - `test/oracle/scenarios.ts` holds 20 scenarios as plain data any sim can run:
    - the old suite's setups: 8 directions, 4 diagonal gaps, a group in the open with a repeated move and queued moves,
      a pinch corridor, routing around a building, production with rally and cancel, and building placement;
    - three seeded random scripts on *Plains of snow BNE* with fog on (moves, queued moves, stops and farm builds by
      both teams, 3,000 ticks each).
  - `npm run record` writes each scenario's trace to `test/oracle/traces/` (376 KB in all): a digest of the observable
    state at every tick, plus the full state every 100 ticks. That state is positions, move targets, buildings, order
    and production queues, rally points, and each team's explored map, with types by name.
  - `test/oracle.test.ts` replays them all, also in reverse order (the old sim's module globals mustn't leak between
    scenarios). It names the first tick that differs and the last checkpoint that agreed. Since W1 the new sim runs here
    too.
  - **What the traces caught:** units that never settle. Their move target stays active while they stand still, and
    the sim keeps working on them every tick:
    - in `pinch-corridor`, two units given a queued move through the corridor never start it;
    - in `production-rally`, two trained units stop just short of a rally point another unit already occupies.

    These are the stuck / settled-short pathologies the old detector flagged. They're recorded as the old behaviour,
    so when W1 fixes them each fix is a documented diff.
  - The incident corpus comes back with the detector in W4. For now these scenarios stand in for it.
- **W1: the sim core, bitecs kept, snapshot contract fixed.** *Done (2026-10-01), bar what's deferred to the pathing
  rewrite below.*
  - **What landed:**
    - The port: `src/sim` is `legacy/src/game` made erasable (`CmdType` a plain object, `.ts` imports, JSON import
      attributes), plus the commands moved out of the old wire protocol. The oracle runs both sims through one adapter
      (`test/oracle/adapter.ts`); the mechanical port matched all 20 traces tick for tick.
    - One field list, `SIM_FIELDS` (from the components, minus the client-only `Unit.selected`/`movable`), now drives
      the snapshot, the restore, the spawn reset (`resetEntity`) and `worldHash` (every field, plus tick, RNG, id
      counter, queues, rally, `lastMove` and the explored maps). `Path.wp*` is snapshotted and reset; `lastMove` is
      snapshotted and keyed by `UnitId`, as are the formation-slot tie-breaks. None of this changed a trace.
    - `test/sim.test.ts` pins the contract (every field restored, a recycled entity starts clean, `lastMove` survives,
      the hash sees every field). `test/snapshot.test.ts` is the restore property: every scenario, restored from its own
      snapshot every 7 ticks, plays exactly as it does uninterrupted.
  - **The one deliberate deviation so far:** restoring every 7 ticks showed the walk grid depended on history. Where
    units overlap, a cell keeps whichever unit moved onto it last, which no snapshot carries. The grid is now repainted
    from positions, in `UnitId` order, at the start of every tick (`repaintWalkGrid`), so it's a function of state. That
    changes only the three random scenarios (their tight spawn clusters overlap; first difference at ticks 7, 207 and 7).
    `test/oracle/deviations.ts` lists them with the reason: the new sim is held to its own trace there
    (`traces/w1/`, `npm run record -- --sim`), the old sim still to the original, and a listed deviation must still
    differ, or the test fails.
    - The validator is netsim's shape: `validateCommand(world, team, unknown)` never throws and returns the command
      normalized (known fields only, `team` stamped) or a typed `Rejection` (`malformed`, `not-allowed`,
      `unknown-unit`, `not-owner`, `wrong-type`, `out-of-bounds`, `full`). Integers and finiteness, map bounds (a
      BUILD's whole footprint), type class (no moving buildings, BUILD only buildings, PRODUCE only what that building
      trains), ownership, the per-team unit cap, plus sanity caps on shift-queued orders (32) and production queues
      (16). SPAWN and SPEED are refused as `not-allowed` (the host's, and a referee control). The NaN
      `CANCEL_PRODUCE` that dropped the queue's head is `malformed` now. `test/validate.test.ts` reaches every
      rejection.
    - Unit type ids come from an append-only table, `src/assets/unitTypeIds.json`, frozen from the sorted keys the
      old sim derived them from, so every id is unchanged; a test holds `units.json` to it and pins a few ids.
    - The entity cap: every spawn checks `hasRoom()` (`MAX_ENTITIES`, the column length less bitecs' id 0) and
      returns -1 past it, spending no stable id; production holds its finished unit and retries, as it does with no
      room to place one.
    - Coverage, netsim-style: `test:node` runs the new sim's tests under `node --test` with thresholds (lines 90,
      branches 85, functions 80, today 90.6 / 87.2 / 80.3). The random scenarios skip it: under V8's precise coverage
      their 3,000 ticks take minutes. They run, uncovered, in `test:oracle` (tsx, for the old sim) with the oracle.
      Functions are low where W2 comes in: the client-side halves of `game.ts` and `snapshot.ts` (known units,
      reconcile). Raise the floors as W2 tests them.
  - **Tried and not taken, for the pathing rewrite:**
    - **mv-1.** Letting settled units block the slip tier (`footprintSoftFreeAt` in place of
      `footprintStaticFreeAt`) does fix the W0 pathology: the never-settling units in `pinch-corridor` and
      `production-rally` settle (by ticks 667 and 281), and the random maps end with fewer stuck. But it breaks the
      "razor" case the slip exists for: in `diagonal-gap-NE`/`-SW` the unit, which threaded the gap cleanly in 57
      ticks, now stalls 35 ticks and settles 56px short. A trade, not a one-line fix. Both sides are acceptance cases
      for the rewrite.
    - **Per-unit speed.** The movement ladder's steps, lanes and progress threshold all assume one global `UNIT_SPD`.
      Footmen and peasants (speed 10) would keep it, but knights (13) and gryphons (14) would exercise tuning nothing
      has checked. It goes in with the rewrite.
    - **The ring-search helper.** The six ring searches are `orders.ts`'s formation and gather logic, which the
      rewrite replaces. Factoring them now would polish code that's about to go.
  - Must pass the W0 oracle (modulo documented deviations) and restore + replay == continuous as a property test.
- **W2: the net layer.** *Done (2026-10-01), bar the worker wiring moved to W3.*
  - First, the PeerJS check: a reliable, ordered PeerJS data channel handed to a worker as it's created, on both the
    dialing and the answering side, in a browser test. If PeerJS won't allow it, decide between relaying through the
    page and owning the peer connection under PeerJS's broker.

    *Done: PeerJS allows it.* `test/browser/peerjs.test.ts` runs two players, each in its own browser context, through
    a local PeerJS broker (PeerJS's own server, in a child process: it never stops its timers). The dialer hands
    `peer.connect(…, { reliable: true, serialization: "raw" }).dataChannel` to its worker straight away: `connect()`
    builds the peer connection and channel synchronously. The answerer, inside `peer.on("connection")`, adds a
    `datachannel` listener to `connection.peerConnection`. That fires after PeerJS's own handler has set `binaryType`
    and listeners on the channel, and the transfer still works. The workers link hubs over the channel: a round trip
    each way, then 2,000 sequenced messages, all delivered in order (`reliable: true` is PeerJS for `ordered`, with no
    retransmit limit). A second test pins the old client's bug: handed over in PeerJS's `open`, the transfer throws
    `DataCloneError`. So war2 keeps PeerJS, and the page never carries game traffic. (PeerJS's own `open`/`close`
    events stop on the page once the channel moves; the worker's hub sees the channel's.)
  - Then, all sim state onto the world. netsim's match tests run a referee and several predicting clients in one
    process, stepped tick by tick over a virtual network with fault injection. war2's sim kept one world per realm in
    module globals (the component arrays, terrain, occupancy, walk grid, flow-field cache, local-path and Dijkstra
    scratch, path obstacles, vision, RNG, id registry), so a second world trampled the first.

    *Done.* `createSimWorld` builds a bitecs world whose context holds all of it: `components` (each world makes its
    own typed arrays, `createComponents`), `fields` (its SIM_FIELDS), `rng`, `nextUnitId` and `eidOf`, `terrain`,
    `occupancy`, `walk`, `obstacles`, `local`, `flow` and `vision`. Every sim function that reads or writes state takes
    the world; systems take their components from `world.components`, bitecs 0.4's idiom. The oracle drives both sims
    through a small per-sim driver (the old one still module-global), and the port still matches all its traces tick
    for tick; old and new run the heaviest scenarios at the same speed. Two tests keep it so: two games interleaved
    tick by tick play exactly as each does alone, and a scan of `src/sim` fails on any module-level variable or
    container that isn't one of the constant lookup tables.
  - netsim's referee and client with war2's sim inside, over hub links on that channel.
  - Prediction ported into the client shape. The host's player as a client worker. Speed as a host RPC. Fog in the
    client worker.
  - In-process tests over netsim's virtual network with fault injection.

    *Done, in process* (`src/net`, `test/net`): netsim's protocol, referee, client and virtual network, with war2's sim
    inside.
    - **What a team sees** (`view.ts`): its own units whole (every sim field, orders, production, rally); enemies in
      sight reduced to what they show (position, type, team, moving and facing, a building's footprint and
      progress), never their move target, path or queues; and what the team has explored, as runs in keyframes and new
      tiles in deltas. Both ends hash exactly that.
    - **The referee** validates every command against the sender's seat (`validate.ts`) as it applies it, so a
      seated client's bad command is refused alone, not its batch.
    - **The client predicts** on a world of its own: its units simulated, visible enemies as display-only colliders,
      exploring switched off (`world.exploring`) with what its team has explored taken from the view, so its pathing
      believes what authority's does. MOVE and STOP apply at once; each update snaps back a unit that has drifted
      8 ticks' travel, or, with nothing in flight, disagrees on where it's headed or where it stopped. Not on
      whether it's still moving: the prediction runs a round trip ahead and arrives first.
    - **Tests:** netsim's match suite ported (17, 0.7s): seats; every client's view equal to the referee's view of
      its team, every tick; fog (nothing out of sight, nothing private of an enemy); exactly-once ordered commands
      over a lossy, duplicating, reordering link; views delayed but never corrupted, converging once it heals;
      prediction at once, settling where authority does with no snaps; permissions (own team's state only, nothing
      before joining, no speaking for another); garbage; rejoin with a token; hash-caught corruption repaired by
      resync; drift snapped back; a closed referee; the per-tick summary; sync while paused. Plus netsim's six
      network tests. Coverage floors are now lines 92, branches 87, functions 86.
    - **Moved to W3:** the host's player as a client worker, speed as a host RPC, and fog drawn in the client
      worker. All three are worker wiring, and the workers are W3's. In netsim, pause and step are served on the
      host tab's own hub (its referee worker), out of every client's reach; war2's speed goes there too. In the net
      layer the host's player is already just another client.
- **W3: the browser.** *Done (2026-10-01).*
  - Pages, instances and lobby from netsim, with PeerJS for players on other machines.
  - The referee and client workers (from W2): the host's player as a client worker like any other, speed as an RPC
    on the host tab's own hub, fog drawn from the client worker's view.

    *Done* (`src/browser`, `index.html`, `play.html`, `instance.html`): netsim's browser runtime carrying
    war2. The host page starts the referee worker and an instance iframe per client; each client worker links to the
    referee over a WebRTC data channel made by the pages and handed to the workers. The host's own player is one of
    them, with no special path. A second tab of `play.html` at the same match joins as another player through the
    lobby (Web Locks + BroadcastChannel). The referee worker serves the host's controls on the host tab's own tree,
    out of every client's reach: inspect, pause and step, and **speed** (0.25–8×). Each client worker sends its page
    only its team's view, its prediction and what its team has explored, so fog is drawn from that: unexplored black,
    out of sight dimmed. The drawing is a debug canvas until the Phaser renderer lands. Page tools: `war2_status`,
    `war2_state`, `war2_divergence`, `war2_control`, `war2_command`. Maps are built in for now (`src/browser/maps.ts`:
    `open`, `arena`); the client's `loadMap` may be async, ready for fetched maps.

    Browser tests on netsim's harness, built and served as it ships (12, about 8s): every client in sync, and paused,
    every view exactly authority's; pause and step exact; speed (4× ticks over 2.5× as fast, clients keeping up); a
    click selecting and moving a unit end to end (predicted at once, then authority's, the same target); the command
    tool refusing another team's unit before it's sent; an instance reloaded mid-match rejoining its seat; players in
    separate tabs in sync, keeping their seat across a reload, let go when their tab closes, told when the host's does;
    and the PeerJS hand-off.

    **Players on other machines** (`play.html?lobby=peerjs`, `peerLobby.ts`): whoever registers the match's PeerJS id
    (`war2-<match>`) with the broker first hosts; a tab that finds it taken joins and dials it, under a name of its
    own kept across a reload (a name that links again replaces its old link). PeerJS makes the peer connections, and
    each data channel goes straight to its worker, as W2's check showed it can. Both lobbies now hand the host the
    same thing, the referee's end of a link (`MakeLink`: give it `take`, and `take` gets the channel in the task it's
    made), so `host.ts` doesn't know which lobby a player came through. Default: PeerJS's cloud broker and its STUN and
    TURN servers. `&broker=host:port` and `&ice=none` point it at a broker of our own with no ICE servers, as the tests
    do (`online.test.ts`, 3): two browser contexts, sharing no BroadcastChannel, lock or storage, play one match in sync
    through a local broker; a reloaded player keeps its name and seat; the player is told when the host goes. A one-off
    run through PeerJS's cloud (not in CI) had both in sync about 2s after opening. The invite link is the page's own
    URL. (The games repo deploys nothing to Pages yet, so for now it's a local dev server's URL.)
  - Phaser 4 bundled.
  - The renderer fed `RenderState` over the hub.
  - HUD and command card.
  - Assets: the ones war2 used, from the same source, loaded on demand.

    *Renderer done (W3c-1)* (`src/render`): the old renderer carried into the instance page, in place of the debug
    canvas.
    - **What's carried:** terrain streamed in 16×16-tile chunks with Stratagus-style fog edges (`ChunkRenderer`, nearly
      verbatim), the data-driven sprite registry, unit animation and facing, interpolation between views, building
      and construction-site sprites, and the minimap.
    - **What it draws from:** the client worker's view, which the hub carries as the instance's `view` subject. Its
      own units come from the prediction, so they turn and walk the moment a command is given; the old
      prediction-overlay map is gone. Fog comes from the view's explored map and its units' sight, by the sim's
      metric, computed once per view rather than over the whole map three times a frame.
    - **Input:** selection hit-tests where units are drawn, and a drag box rings only your own (two of the audit's
      rendering findings). Right-click moves the selection, or sets a selected building's rally point. The instance
      sends these as intents to its worker, which validates each command against its prediction before predicting
      and sending it.
    - **Phaser 4.2.1**, pinned and bundled; its minified build via war2's `vite.config.ts` (war2's own code stays
      unminified, util's default): `instance.js` is 1.9 MB rather than 7.2.
    - **Assets on demand** from the mirror (`browser/assets.ts`): the map when a match starts on it, the tileset, and
      each unit type's sheet the first time one is drawn. The metadata it reads (sprites, constructions, icons,
      terrain classes) is committed in `src/assets`, as before. Maps are the built-in two or the mirror's by path; the
      default is `ladder/Plains of snow BNE`, the map the old war2 booted on, with each team placed at its start (map
      properties). Humans and orcs alternate by team.
    - **Tests:** the click test now selects a unit where the renderer draws it and right-clicks a tile beside it,
      through Phaser; a new test checks Plains of snow renders its tileset and every unit's sprite. (The browser tests
      reach the mirror, as CI already reaches Pages for its tarballs.)

    *HUD and command card done (W3c-2):*
    - **Carried:** the DOM HUD from the old `client.html` (the holy-grail frame: resource bar, minimap cell, status
      strip, portrait, command card) in `instance.html`, wired by `render/hud.ts`; `abilities.ts` and
      `commandCardController.ts` moved out of the sim folder into `src/ui/` (the audit's "client UI living in the
      sim"). The card is the old navigation stack: B opens the build menu, a letter arms a building's placement (the
      ghost follows the cursor, green where it fits), a click places it, Escape backs out a level at a time,
      right-click cancels whatever's armed; a hall's slot trains its worker; the status strip shows a building's
      production with a progress bar, and clicking an item cancels it. The portrait, empty before, shows the
      selection's icon and name.
    - **Placement** is judged in the page, advisory, as the sim judges it (terrain and buildings, not units); the
      referee re-checks it.
    - **Starts:** each team now opens as WC2 does: a finished town hall (great hall for orcs) at its start, two
      workers, soldiers for the rest.
    - **One player per window:** `play.html` gives its player the whole window, the game edge to edge with the HUD at
      full size, and the host's sync table folds away under "sync" in the header. `index.html` stays the harness:
      every player of a match in one tab, side by side.
    - **Tests:** `test/ui.test.ts` (5) drives the card's logic directly: each selection's card from the game's data,
      unique hotkeys, the navigation stack, placement (valid, invalid, cancelled), move targeting, training.
      `test/browser/hud.test.ts` (2) plays it in a real window: select a peasant, B, F, the ghost, a click on open
      ground, and the referee has a farm under construction there; select the town hall, click its train slot, the
      peasant's in production and in the status strip, and clicking it there cancels it.
- **W4: tools and the browser safety net.**
  - war2's page tools: `war2_state`/`unit`/`map`/`trace`/`summarize_move`/`control`/`command`/incidents.
  - The pathology detector, and incident capture → fixture JSON.
  - Browser tests on netsim's harness, with the pathology guard running in CI.
  - The zero-knowledge comparison extended to war2.

    *Done, bar the zero-knowledge comparison:*
    - **The pathology detector** (`src/diag/pathology.ts`), carried from the old referee as an instance: give-up,
      stuck, settled-short, oscillating — and a new kind, **stalled** (moving, but no closer to its target for 5 s).
      W0's stuck pairs in pinch-corridor and production-rally turned out to be jittering a few pixels to and fro every
      tick, which keeps resetting the stall counter, so they never escalate, never settle, and slipped past the old
      kinds; stalled catches them. Two old false alarms are fixed: give-up fired on a group's units already in their
      slots (now judged for a lone unit only, with a tile's slack), and settled-short on units their player stopped.
    - **The census** (`test/oracle/census.ts`, `traces/pathologies.json`, `npm run record -- --census`): every
      scenario run with the detector watching, each fault and the tick it showed, pinned like a trace. Quiet on all
      15 clean scenarios; pinch-corridor and production-rally's stalled pairs; the random maps' 13–15 faults each
      (stalls, a few oscillations, one stuck unit settling short) — the pathing's known faults, for the rewrite to
      clear, each clearing a deliberate diff.
    - **The flight recorder** (`src/diag/recorder.ts`), watching the referee after each step (`RefereeOptions.observe`):
      snapshots every 30 ticks (the last six: ~9 s of lead-up), the last 30 s of applied commands, each unit's track
      (tile, when), the detector's current faults, and incidents — auto-flagged (a give-up, settle short or stall at
      once, a stuck unit once it stays stuck; debounced, never the same unit and fault twice in 30 s) or by hand. An
      incident is its lead-up snapshot, the commands since, and the world's hash at the flag. Pulled by the host's
      tools over RPC (`war2.local.referee.diag`) — nothing pushed per tick.
    - **Replay** (`src/diag/replay.ts`): a fixture rebuilt on its map (by name, or inline for a scenario's), restored,
      its commands applied at their ticks — it must reach the flagged world's hash exactly — then on, with the
      detector watching the focus unit. Live, `Referee.restore` rewinds the running match to an incident's lead-up,
      paused, its commands scheduled to apply again as it's stepped.
    - **The incident corpus** (`test/incidents/`, `test/incidents.test.ts`): each fixture replays faithfully and
      meets its expectation — its fault shows again (a known bug, pinned; flip it to `reachesGoal` once fixed) or the
      focus unit reaches its goal. Seeded with the two stalls (`npm run record -- --incident <scenario>`); a tampered
      fixture is caught.
    - **Page tools:** `war2_pathologies`, `war2_unit` (state, fault, track), `war2_trace`, `war2_region` (pairwise
      clearances), `war2_summarize_move`, `war2_incidents`, `war2_flag_incident`, `war2_replay_incident`,
      `war2_save_incident_test` (returns the fixture JSON and its path, for the agent to write).
    - **The guard in the browser:** `assertQuiet` (harness.ts) fails a test the detector flagged anything in; it runs
      at the end of every browser test that gives deliberate orders (bots wander into the known faults). Plus
      `WAR2_CPU_THROTTLE=<n>` to play CI's slower runners locally.
    - **Tests:** the detector (census and synthetic cases), the recorder (what it keeps, auto and hand flags, fixtures
      round-tripping through replay), the corpus, the map loader (a stubbed mirror); in the browser, an incident flagged
      in a live match and saved through the tool replays in node to the captured hash, and a live replay rewinds and
      steps back to the flagged moment exactly.
    - **On the way:** the order-sensitive systems (movement, production) walk units in stable-id order, not bitecs's
      entity order, so a world restored in place plays as one restored fresh (a safeguard: no trace moved). The HUD's
      status strip and portrait update in place, rather than rebuilding under the pointer 20 times a second (CI caught
      a lost click).

- **W5: in the editor, then the game.**
  - war2 in an editor preview and across tabs, over WebRTC.
  - Then war2's own roadmap (its `PLAN.md`): combat, then economy, tech, and AI, onto a foundation where every change
    is guarded.

## Decisions

Decided 2026-10-01:
- **bitecs: keep it.** It's the game maker's substrate.
- **PeerJS: keep it.** It covers discovery and the connection across machines, and its free TURN relays let two
  people playtest from different machines with no servers of ours.
- **TypeScript: keep the relaxed defaults.**
- **Assets: use what war2 was using.** The same files, from the same source (the `assets` repo's Pages mirror at
  `/assets/war2/`). The loader can still skip what's already present and load on demand, rather than wiping and
  re-downloading everything on each install.
- **The step debugger: retire it.** The editor's debugger takes its place. The breakpoint, data-breakpoint and
  reverse-step machinery in `referee.worker.ts` doesn't move.
- **Host restore: later.** For now a match ends when its host leaves, as in netsim. Revisit once snapshots are
  complete.
- **Pathing: carried as-is, rewritten later.** It's been buggy: flow fields for long distances, A* for short, with the
  stuck and settled-short units W0's traces caught. W1 moved it over unchanged, bar the walk-grid repaint (a
  determinism fix). mv-1 turned out to be a trade, not a one-liner, and went to the rewrite with per-unit speed and the
  ring searches (see W1). The rewrite comes once war2 is settled on the new stack, against the traces and scenarios W0 built.
- **Gameplay (combat onward): after the port (W4).** The port stays behaviour-preserving, so the W0 traces keep
  checking every step; combat begins in W5.
