# war2 — agent guide

Deterministic, fixed-point **lockstep RTS** (FP=1000, TILE_PX=32) on a bitecs ECS,
host-authoritative referee with fog of war. The sim is pure and snapshot/replayable —
the same inputs always reproduce the same state, which is what makes captured repros exact.

## Build / test
- `CI=1 npm test` — full suite **headless / in-process** (deterministic, instant). Use for sim logic.
- `npm test` — same suite in **browser mode** against a live host (watchable). Needs `npm run dev`
  (boots the dev server + the debug WS on :9229). Browser mode drives ONE shared host, so it MUST run
  serially (`--test-concurrency=1`, already in the script) — never `node --test` the files in parallel.
- **Run BOTH modes.** The in-process path uses `createGame` directly; the browser path runs the real
  `referee.worker` tick loop. A worker-only bug (e.g. an undefined reference inside `detectPathologies`)
  is invisible to headless *and* to tsc, and only surfaces in browser mode — usually as "units don't move /
  first test passes, rest fail" once a throw kills the self-rescheduling tick loop.
- **Seeing console output.** `preview_console_logs` only reads the TOP page — it never sees the box
  iframes or their workers. To read a game's logs, use the **`get_console`** MCP tool (or `console`
  query): it returns **both** boxes' console (`host`/`peer`), each merging the main thread (`client`) and
  the sim **worker** — relayed to the debug server, no overlay needed. Each box wires this identically via
  `wireBoxConsole(post)` + `initDebugClient(role)` (debug/client.ts). Humans can also toggle the per-box
  in-game overlay (`debug/console.ts`, **`` ` ``**), which shows the same merged stream on-page. Caught
  referee throws additionally hit `preview_logs` (search `diag-error`).

## Debug / inspector tooling (dev only, port 9229)
`tools/debug-server.mjs` is a hub: the browser game pushes per-tick state to it; Claude/inspectors pull.
Claude connects over MCP (`games/.mcp.json` → `http://localhost:9229/mcp`). Determinism means anything
captured here is an **exact, replayable repro**.
- Read: `get_status`, `get_state`, `get_unit`, `get_map` (off-centre offsets + phantom/overlap/hole cells;
  `fine:true` = 8px walk grid), `trace_unit`, `summarize_move` (reached / short-settle / stall / stack),
  `get_diff`, `find_divergence`, `get_console` (each game's console — main thread + sim worker).
- Drive: `pause`/`resume`/`step`, `move_units`, `stop_units`, `spawn_unit`, `build`, `produce`, `set_rally`, `cancel_produce`, `load_scenario`.
- Incidents: `flag_incident`, `list_incidents`, `get_incident`, `replay_incident`, `save_incident_test` (see below).

## Investigating pathing / collision incidents
An incident is a self-contained, **replayable** repro (full snapshot + map + recent command log + label).
Captured three ways:
- **Auto:** a read-only detector in `referee.worker.ts` (`detectPathologies`, post-step, never mutates the
  sim) flags **stuck** / **give-up** / **settled-short** / **oscillating** units each tick, shows a
  `⚠ N pathing` HUD badge, and debounced-auto-flags sustained episodes (label `auto: <kind> uid<n>`).
  - **The e2e harness asserts this detector stays SILENT.** In browser mode every `settle()`/`step()` calls
    `assertQuiet()` (test/harness.ts): it baselines the incident store at `load()` and fails the *current*
    test — naming the offending `auto:` label — if any new incident was flagged while the host ticked. So a
    regression that makes a passing scenario path badly fails the suite even if the units still reach their
    goal. Headless mode can't run this (the detector lives in the worker, not the sim) — it's a no-op there,
    so browser mode is load-bearing for it. A scenario meant to be pathological opts out: `settle(ids, true)`
    / `step(n, true)` (the `expectIncidents` flag).
- **Manual:** press **backslash (`\`)** in-game (backtick is the console toggle), or call `flag_incident`.

To investigate a flagged incident:
1. `list_incidents` → repros (id, tick window, label). Read the `label` — a bare snapshot tells you *where*,
   not *what's wrong*; `auto:` labels name the pathology, a manual label carries the human's intent.
2. `replay_incident <id>` → restores the exact snapshot onto the host (rebuilt on its map, **PAUSED** at the
   lead-up tick). `get_incident <id>` returns the in-window commands + a compact unit list.
3. Step + diagnose with `trace_unit`, `summarize_move`, `get_map fine:true` — look for high `stuckTicks`
   (thrashing), short-settle, oscillation/rubber-band, or phantom/overlap reservations. Re-apply the
   incident's commands to drive the lead-in.
4. **Decide if it's a real bug.** A genuinely-unreachable give-up is *correct* behaviour, not a bug — skip it.
5. **Lock the fix with a regression test:** `save_incident_test <id>` writes `test/incidents/<id>.json`
   (map + snapshot + commands + focus unit/goal); `test/pathing.incidents.test.ts` globs those, replays each
   deterministically under CI, and asserts the focus unit reaches its goal. **Review the generated `expect`**
   (delete the fixture if the incident wasn't a bug; adjust to `maxStuck`/etc. as needed). For hand-built
   repros the older pattern still works: `load_scenario` → `step` → assert, via the dual-mode driver
   (`test/harness.ts`, `test/pathing.*.test.ts`). The growing fixture corpus is the anti-regression net.

## Gotchas
- **Phaser runs in mouse-event mode.** Synthetic `PointerEvent`s don't register for selection/clicks —
  dispatch `mouse*` events (mousedown/move/up; button 0 = drag-select, button 2 = right-click move,
  `shiftKey` = queue). This is how to drive the live game from outside (e.g. `preview_eval`).
- **Determinism boundary:** the world hash covers only `Position` + `UnitId`. Queue state lives on
  `world.orders` / `world.production` / `world.rally` (keyed by stable uid) and rides snapshots.
  Never read a component value-array as a presence flag — use bitecs `hasComponent` (`Building` is the
  only conditionally-added component; everything else is on every entity).
- **Buildings share the unit entity pool** (Position/Unit/UnitId + inert MoveTarget/Path/UnitAnim).
