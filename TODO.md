# TODO

- [ ] **Ensure the tests run in CI.** Wire `npm test` (war2) into CI. Note the suite is two-tier: the
  in-process tests run anywhere, but the host-connected ones (`pathing.*`, `movement.groups.visual`)
  need a live host on the debug server — see the item below.
- [ ] **Ensure the test harness can be run outside of the Claude preview.** The host-connected tests
  currently rely on the Claude Preview dev server (the `npm run dev` debug-server on :9229 + a booted
  war2 host box). Make the harness stand up its own host/dev server (and headless browser via
  `ensureWar2`) so the suite runs from a bare `npm test` — locally and in CI — without the preview.
