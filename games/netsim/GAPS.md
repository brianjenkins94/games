# Gaps found by netsim

netsim exists to find what the editor's stack (and the tooling around it) is missing before war2 depends on it.
Every gap it turns up goes here — open ones at the top, fixed ones kept below with where they were fixed.

## Open

### hub (`editor/packages/hub`)

- **No in-memory transport or fault injection.** hub's own tests have a `pipe()`, but nothing is exported, and
  nothing injects drops, duplicates or reordering. netsim wrote its own (`src/net/network.ts`). Candidate to move
  into hub.
- **A transport can't read a frame's subject.** Frames are wrapped under a private key (`"\0hub"`) with no accessor,
  so a transport that treats game traffic differently (drops it, prioritizes it) has to recognize envelopes by shape
  — which is how netsim first mistook control frames for game traffic.
- **Control frames assume reliable delivery.** A lost `sub`/`unsub` isn't repaired until a reconnect (`hello`
  re-advertises). Fine over a MessagePort or a reliable channel; a problem over an unreliable WebRTC data channel.
- **The published tarball is untyped.** Its declarations are at `src/index.d.ts` and `package.json` has no `types`,
  so consumers' hub imports are `any` (a call with wrong arguments type-checks).
- **An untrusted peer's hub id must equal the id its edge assigns** (`LinkOptions.peer`), or its RPC replies can't
  reach it: the RPC client listens on `$rpc.reply.<its own id>`, and the edge only permits `$rpc.reply.<assigned>`.
  Documented; whoever creates a client must tell it its id. Could be lifted by addressing replies to the
  authenticated `from`.

### netsim itself

- **A reloaded instance is lost for the rest of the match.** The page brokers an instance's channel to the referee
  only on its first load, the instance doesn't keep its seat token, and the referee would have to replace the old
  link for the same peer id. war2 players will refresh. A `todo` browser test covers it (M2d).
- **The status table can't tell a dead client from a live one.** A client that stops reporting keeps the state of
  its last report ("in sync") — only the lag column gives it away. Needs a liveness check (stale diagnostics).

### observability / debug-mcp (`editor/packages/observability`, `editor/packages/debug-mcp`)

- **An unhandled worker error is reported twice**: once by the worker (over its hub, with its stack) and again by the
  page that owns it, which the browser re-raises it in — attributed to the page. netsim marks those handled
  (`ownWorker` in telemetry.ts); it belongs in observability, next to `tapConsoleAndErrors`.
- **`page_eval`'s direct `eval` makes every consumer's build warn** (Rolldown's `[EVAL]`, three times per build).
  An indirect eval (`(0, eval)(expression)`) evaluates in global scope, which is what page_eval means anyway.
- **Records logged before the debug-mcp link is up never reach it.** The page's first line ("match starting") is
  logged ~50ms before its socket connects, and nothing replays it — so debug-mcp misses exactly the startup records.
  The page's collector has them; `linkDebugMcp` could replay them on connect. A `todo` browser test covers it.
- **debug-mcp's tarball has no types for its entry points** (`.` → `index.js`, `./mcp` → `mcp.js`; the `.d.ts` files
  ship under `src/` unmapped), so a consumer's imports are `any` — like hub's.

- **Tabs with the same hub ids are merged.** debug-mcp's logs and architecture key contexts by hub id alone, so two
  netsim tabs (each with a `referee`, `client-0`, …) interleave into one. Affects the editor too (every tab has a
  `root`). Needs tab-scoped identity in the collected streams.
- **Permissions for observing an untrusted peer are netsim's.** `observabilityPermissions(peer)` (publish its own
  `$sys.log.<id>` / `$sys.arch.<id>`, receive `$sys.arch.sync`) is generic; it belongs in observability.
- **The collector tags a record by the source it claims.** `LogRecord.context.source` is data the sender writes;
  permissions enforce the *subject* (`$sys.log.<id>`), so the tag could disagree with it. Tag by subject instead.
- **A page tool that goes away stays registered.** debug-mcp registers page tools live with util/mcp's `updateTool`,
  but util/mcp has no removal, so a tool whose tab closed stays listed and answers that no connected tab serves it.
  Needs a `removeTool` in util/mcp (the SDK's `RegisteredTool.remove()` exists).
- **debug-mcp reads the SDK's private tool map** (`_registeredTools`) to keep a page from taking over one of its own
  tools' names; util/mcp exposes no listing. Needs a listing (or a "has") in util/mcp.
- **Page tools need a debug-mcp restart to appear** the first time debug-mcp is upgraded to a version that has them —
  only an operational note, but worth knowing: an older running debug-mcp ignores them silently.

### editor CI (`editor/components/monaco-vscode-api`, `editor/packages/vscode`)

- **The component's install races upstream's releases, and hides the failure.** `install.sh` clones the demo at
  monaco-vscode-api's newest *git tag*, then `npm install`s it — but upstream pushes the tag minutes before it
  publishes to npm, so in that window the install fails (`ETARGET … @codingame/monaco-vscode-api@37.3.0`), and the
  script still exits 0. It broke editor CI on 2026-09-30 (a re-run after the npm publish passed). Resolve the version
  from npm (`npm view … version`), not git, and fail on a failed install.
- **The editor's lint only passes when that demo is installed.** `packages/vscode`'s extensions import `"vscode"`,
  and in the root-tsconfig program the only thing that satisfies it is the demo's
  `node_modules/@codingame/monaco-vscode-api/vscode-dts/vscode.d.ts` (an ambient `declare module "vscode"`). Without
  it, TypeScript resolves `"vscode"` as a self-reference to the editor's own package (named `vscode`, exporting
  `vscode.tsx`), and `Uri` / `TextDocument` / `Disposable` become error types (`ts/no-redundant-type-constituents`).
  A `paths` entry for `vscode` (to `@types/vscode`), or not naming the workspace package `vscode`, would decouple it.

### lib / tooling

- **`util-dev` is fixed to port 5173**, which the editor's dev server uses; netsim calls `serve(cwd, 5180)` itself.
- **TypeScript `latest` is 7.0, which typescript-eslint doesn't support yet.** The games repo pins `^6.0.3`.
- **util/playwright's `launch()` is a scraping helper**: headful with devtools by default, one browser per process
  held in module state, closing the page closes the browser, and importing it loads Vite. Test harnesses (the
  editor's, netsim's) use Playwright directly, each with its own "find a Chromium" fallback chain — a shared test
  launcher belongs in util.
- **util/vite/dev's `serve()` returns nothing** — no way to stop it or know its port is listening — so a test can't
  own a dev server. netsim's browser tests serve the build instead (and take `NETSIM_URL` for a running server).
- **Browser code isn't measured for coverage.** `src/browser/**` is excluded from the node coverage run, and
  Playwright's coverage API covers pages but not workers (where the referee and clients run). Needs V8 coverage
  collected per target over CDP (or instrumented builds reporting over the hub).
- **A local `util-publish` run leaves `.d.ts` files in the source tree** — of the package it builds and of any
  sibling whose sources it imports (debug-mcp → `observability/src/*.d.ts`). Harmless in CI's throwaway checkout;
  locally they're untracked litter to clean up by hand.
- **util's Vite is a peer dependency**: an app using `util/vite/*` must declare `vite` itself (pnpm won't hoist it).

## Fixed

- **debug-mcp couldn't be installed from its tarball** — hub as `file:../hub`, util as a URL dependency (pnpm's
  `ERR_PNPM_EXOTIC_SUBDEP` for any consumer), and a `bin` pointing at an unshipped `src/bin.ts`. Now hub and util are
  peers (tarballs as devDependencies), and the bin is built (`./bin` export → `bin.js`; the source's own shebang
  dropped, since the publisher adds one). editor `ef6ff3d`. netsim's browser tests now drive a real debug-mcp
  in-process: page tools registered live, called over MCP, plus `query_logs` / `get_architecture` / `list_tabs`.

- **debug-mcp could expose only its own tools** (`page_eval`, `page_query`, …), so a game's state, divergence and
  pause/step had to be reached by evaluating expressions. Now a page serves its own MCP tools
  (observability's `servePageTools(hub, { tools })`), and debug-mcp registers them live (`tools/list_changed`) and
  forwards calls to the tab. editor `53ea8f6`; netsim serves `netsim_status`, `netsim_state`,
  `netsim_divergence`, `netsim_control`, `netsim_command`.

- **hub had no access control and no sender identity** — any linked hub could subscribe to any subject (another
  team's state, another caller's RPC replies) and claim any id. Now: `link(transport, { peer, permissions })`,
  `hub.permit()`, handlers' `origin.link`, serve's `from`, a `deny` tap event. editor `d94e3fa` (hub 0.8); netsim uses
  them in `3ab2fda`.
- **hub's source had a literal NUL character**, so git treated it as binary and diffs were unreviewable. editor
  `d94e3fa`.
- **observability depended on hub as `file:../hub`**, unusable from its tarball under pnpm. A direct URL dependency
  then failed the editor's own install (`ERR_PNPM_EXOTIC_SUBDEP`). Now hub is a peer dependency, with the tarball as
  a devDependency. editor `9070e3a`, `34a8019` (observability 0.11).
- **util's ESLint config autofixed `node:test` imports to `vitest`** (not installed) — how war2's whole suite silently
  stopped loading. lib `ebf8b4d`.
- **CI's `strictDepBuilds` only reached the root workspace**, so a sub-package's build failed on ignored build scripts
  (`ERR_PNPM_IGNORED_BUILDS`). lib `dd185ee`.
- **Build workarounds living in the editor** — vite-plugin-node-polyfills' shim resolution under strict pnpm, and
  builtin subpaths (`node:util/types`) — moved into util's `polyfillNode`. lib `c19512f`.
