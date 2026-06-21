# TODO

- [x] **Test harness runs outside the Claude preview.** The driver (test/harness.ts) has two modes:
  `CI=1 npm test` runs the full suite fully in-process (headless — no browser, no debug-server,
  deterministic, ~3s), and `npm test` locally drives a real browser via the same driver (verified
  working against a real browser). The Claude-preview dependency is gone.
- [ ] **Wire `CI=1 npm test` into an actual CI workflow.** The suite is now CI-ready (headless,
  deterministic); the only remaining step is a pipeline config that runs it.
