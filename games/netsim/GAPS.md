# Gaps found by netsim

netsim exists to find what the editor's stack (and the tooling around it) is missing before war2 depends on it.
Every gap it turns up goes here — open ones at the top, fixed ones kept below with where they were fixed.

## Open

### hub (`editor/packages/hub`)

- **Control frames assume reliable delivery.** A lost `sub`/`unsub` isn't repaired until a reconnect (`hello`
  re-advertises). Fine over a MessagePort or a reliable channel; a problem over an unreliable WebRTC data channel.
- **The published tarball is untyped.** Its declarations are at `src/index.d.ts` and `package.json` has no `types`,
  so consumers' hub imports are `any` (a call with wrong arguments type-checks).
- **An untrusted peer's hub id must equal the id its edge assigns** (`LinkOptions.peer`), or its RPC replies can't
  reach it: the RPC client listens on `$rpc.reply.<its own id>`, and the edge only permits `$rpc.reply.<assigned>`.
  Documented; whoever creates a client must tell it its id. Could be lifted by addressing replies to the
  authenticated `from`.

### observability / debug-mcp (`editor/packages/observability`, `editor/packages/debug-mcp`)

- **An unhandled worker error is reported twice**: once by the worker (over its hub, with its stack) and again by the
  page that owns it, which the browser re-raises it in — attributed to the page. netsim marks those handled
  (`ownWorker` in telemetry.ts); it belongs in observability, next to `tapConsoleAndErrors`.
- **`page_eval`'s direct `eval` makes every consumer's build warn** (Rolldown's `[EVAL]`, three times per build).
  An indirect eval (`(0, eval)(expression)`) evaluates in global scope, which is what page_eval means anyway.
- **debug-mcp's tarball has no types for its entry points** (`.` → `index.js`, `./mcp` → `mcp.js`; the `.d.ts` files
  ship under `src/` unmapped), so a consumer's imports are `any` — like hub's.
- **Permissions for observing an untrusted peer are netsim's.** `observabilityPermissions(peer)` (publish its own
  `$sys.log.<id>` / `$sys.arch.<id>`, receive `$sys.arch.sync`) is generic; it belongs in observability.
- **The collector tags a record by the source it claims.** `LogRecord.context.source` is data the sender writes;
  permissions enforce the *subject* (`$sys.log.<id>`), so the tag could disagree with it. Tag by subject instead.
- **Page tools need a debug-mcp restart to appear** the first time debug-mcp is upgraded to a version that has them —
  only an operational note, but worth knowing: an older running debug-mcp ignores them silently.

### the editor, running netsim (M3)

- **netsim's `npm run dev` can't run in the editor.** It's `node scripts/dev.ts` (util's `serve`); the editor's
  terminal starts a preview only through its own `vite` command (which ignores its arguments). In the editor, run
  `vite` in `games/netsim`. A dev script both can run (plain `vite`) would make `npm run dev` and the Run picker
  work in both places.
- **An app in a preview shares its editor tab's log stream in debug-mcp**: its records are filed under the editor
  tab (they ride its socket), so `query_logs` for the app's tab returns the editor's records too — filter by
  `source`.
- **The editor's tap isn't injected into workers**: a previewed app's worker console output and sockets are neither
  captured nor capability-gated.
- **Loading a repo needs a GitHub token**, even a public one (the loader is shown only once a PAT is connected).

- **In the editor, every port shares one origin** (ports are paths under `/__virtual__/`), so origin-scoped state —
  storage, Web Locks, BroadcastChannel — is shared across ports there and not on a desktop. netsim must not rely on
  it: players are tabs (windows) on one server.
- **A player can't follow its match to a new host.** When the host's tab goes, its players are told and stop; the
  match's state went with the host (host-authoritative). Reloading hosts or joins afresh.

### editor CI (`editor/components/monaco-vscode-api`, `editor/packages/vscode`)

- **The editor's lint only passes when the monaco-vscode-api demo is installed** (the component's `install.sh` sets it
  up; it can come up empty when upstream tags a release before publishing it to npm, as on 2026-09-30). `packages/vscode`'s extensions import `"vscode"`,
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
- **A fresh `pnpm install --ignore-workspace` of an editor package links nothing at the top level** (pnpm 12 writes a
  `.package-map.json` instead), so plain `node` can't resolve its dependencies. The packages are installed with npm
  locally (flat); a reused pnpm store also serves a stale copy of a mutable `@latest.tgz`.
- **util's Vite is a peer dependency**: an app using `util/vite/*` must declare `vite` itself (pnpm won't hoist it).

## Fixed

- **In the editor, a second player had no window to play in** — the editor tied one preview window to one port, and
  "open another player" left the editor as a browser tab (a second `vite` only worked because the editor serves every
  port from one origin, which a desktop doesn't). Now a server has as many preview windows as the user opens: a
  window's "new window" button, or the app's own same-server `window.open` / `target="_blank"` link, opens another
  (each its own page, its app's hubs scoped under the window). Seen live: `play.html`'s link opening Preview :5173 (2)
  as player-1 in the host's match, on one server. editor `5a1e9f7`, `055eefa`, `b1f0db1`.
- **The editor's architecture view flagged netsim's hubs as undeclared** — they reached it through the preview link,
  but were checked against the editor's model ("needs review"). Contexts beyond a `preview:*` link are now the app's:
  drawn in an "App" group inside Previews, the page hub merged into its `preview:<port>` node, each frame under the
  window that loaded it and each worker under its window, and left out of the editor's conformance check. Hubs report
  their realm (window/frame/worker, URL, parent URL) so the view can place them. A worker's nesting is inferred (its
  one linked window); observing `new Worker` directly would make it certain. editor `bc86c8a`, `6f3e6fe`.
- **netsim's hubs couldn't join the editor's hub tree** (M3c) — no link accepted a preview frame, so its logs,
  architecture and `netsim_*` tools stayed out of the editor, and its own debug-mcp socket tripped the editor's
  capability prompt. Now the shell links each preview's page (non-transit, confined to observability, tab discovery
  and page tools), netsim's page links up with observability's `linkPreviewHost` (falling back to `linkDebugMcp`
  standalone), and debug-mcp treats the app as a tab of its own riding the editor tab's socket: its tools work
  without naming a tab. Seen live: netsim running in the editor, its hubs in the editor's architecture view, and an
  agent pausing it and diffing every client against authority over debug-mcp → the editor's tree → the preview.
  editor `26be08f`, `2c2abbc`.
- **A games CI flake: netsim's tools sometimes never registered in debug-mcp.** The page announced its tools before
  its debug-mcp socket was up, and a slow start missed debug-mcp's one re-read. observability now re-announces them
  once any collector link is ready. editor `26be08f`.

- **The editor's preview half-supported nested frames, and HMR re-ran modules it couldn't swap** (M3b). The injected
  tap posted a nested frame's logs (and capability requests) to `parent` — netsim's page, and its `message`
  listeners — instead of the editor; HMR reached only the top frame; and on any JS change the HMR client re-imported
  the module into the window whether or not it had loaded it or could swap it (a plain `.ts` module ran twice —
  editing netsim's `page.ts` would have started a second match). Now the tap posts to the editor window hosting the
  preview (tagging a nested frame's records with its path), the shell attributes any frame inside a preview to it,
  HMR goes to every frame, and each frame's client acts only on modules it loaded: a React module is refreshed in
  place, anything else reloads that frame. editor `456fd9a`.

- **The editor's previews couldn't run netsim's imports**: a URL/tarball dependency (`@brianjenkins94/hub`,
  `observability`, `util`) became a broken esm.sh URL, and a module worker can't use the page's import map at all.
  Now almostnode's dev server fetches a tarball dependency once, unpacks it in memory and serves it from
  `/@pkg/<name>/…` (by its `exports`), and rewrites every served module's bare imports to URLs — so they resolve in
  workers too. netsim runs in the editor's preview (3 clients, exactly in sync with the referee); the editor's
  architecture suite covers the shape (a tarball dep, a module worker, a nested iframe, a MessageChannel). editor
  `771f95f`.

- **`link()` didn't say which link it made, and only some debug-mcp tools were per tab.** hub's link handle now
  carries its `id` (editor `5205b87`), and debug-mcp's `query_spans`, `get_tree_state` and `wait_for` take `tab` and
  name each row's tab like `query_logs` — spans keyed per tab, so two tabs' same-id spans stay apart (editor
  `8ae0b6a`).

- **hub had no in-memory transport or fault injection, and a transport couldn't read a frame** — hub's tests had a
  private `pipe()`; netsim wrote its own and recognized frames by shape. Now hub exports `pipe()` (MessagePort-like,
  or `lossy` like a window) with a `schedule` hook deciding how each message travels — all fault injection needs —
  and `frameOf(message)`. netsim's virtual network is built on them. editor `8ba9ce4`.
- **A one-off message published right after linking could be lost** — a hub forwards only what it knows the far side
  wants, and it answered a peer's `hello` before re-sending its interest, so even having the peer's hello didn't mean
  knowing its interest. Now a hub re-sends its interest first; `link()` returns `ready` (the peer's interest is
  known); and `hub.publishWhenInterested` waits for a listener. (netsim keeps its seat token as state in every view
  anyway — for state that's the simpler, self-healing choice.) editor `8ba9ce4`.
- **debug-mcp merged tabs whose hubs share ids** (two netsim tabs' `referee`s, every editor tab's `root`). Now it files
  records and architecture by the link they arrived on (one per tab): `query_logs` names each record's tab and takes
  `tab`; `get_architecture` is per tab and asks which when several are connected. editor `97d3b18`; netsim's browser
  test runs two matches in two tabs against one debug-mcp.
- **A page's tools stayed listed after the page went, and debug-mcp read the SDK's private tool map** — util/mcp had
  no removal or listing. Now it has `removeTool` and `toolNames` (lib `cf70518`), and debug-mcp removes the page tools
  no connected tab serves (editor `b5a0f47`).

- **Records logged before the debug-mcp link was up never reached it** — the page's startup, mostly ("match starting"
  is logged ~50ms before the socket opens). observability's `linkDebugMcp` now holds the root's records
  (`logBacklog`) until debug-mcp's interest arrives and sends them as one backlog on `$sys.backlog.log`, which
  debug-mcp files with the rest; a record is either sent live or held, never both. Re-arms on a reconnect. editor
  `32c7002`; netsim's browser test checks the startup record reaches debug-mcp exactly once.
- **The status table couldn't tell a dead client from a live one** — a client that stopped reporting kept its last
  state ("in sync"). Clients report every tick, paused or not, so one silent for over a second now shows as
  **stalled** (in the table and `netsim_status`); a paused match stays "in sync".

- **A reloaded instance was lost for the rest of the match**, and a client reclaiming its seat couldn't play: its
  command batches restarted at 1, and the referee (which takes batches strictly in sequence) dropped them forever.
  Now the join reply carries the seat's `nextSeq`; the page re-brokers an instance's channel on every load; the
  referee worker replaces a peer's dead link; and the instance keeps its seat token in `sessionStorage` (per match),
  so its new worker rejoins. Covered in node (a fresh client's commands land after rejoining) and in the browser (a
  reloaded instance rejoins its seat, catches up exactly, and plays on).

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
