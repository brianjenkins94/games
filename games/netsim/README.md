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

## Test

```bash
npm test
```

Runs on `node:test` with type stripping (no build step), with coverage thresholds (95% lines and functions, 90%
branches) enforced.
