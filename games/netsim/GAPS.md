# Gaps found by netsim

netsim exists to find what the editor's stack (and the tooling around it) is missing before war2 depends on it.
Every gap it turns up goes here — open ones at the top, fixed ones kept below with where they were fixed.

## Open

### hub (`editor/packages/hub`)

- **Control frames assume reliable delivery.** A lost `sub`/`unsub` isn't repaired until a reconnect (`hello`
  re-advertises). Fine over a MessagePort or a reliable channel; a problem over an unreliable WebRTC data channel.
### the editor, running netsim (M3)

- **Loading a repo needs a GitHub token**, even a public one (the loader is shown only once a PAT is connected).

- **In the editor, every port shares one origin** (ports are paths under `/__virtual__/`), so origin-scoped state —
  storage, Web Locks, BroadcastChannel — is shared across ports there and not on a desktop. netsim must not rely on
  it: players are tabs (windows) on one server.
- **A player can't follow its match to a new host.** When the host's tab goes, its players are told and stop; the
  match's state went with the host (host-authoritative). Reloading hosts or joins afresh.
- **An app's own new window has no handle.** The editor turns a same-server `window.open` into another preview window,
  so the call returns `null` (as a blocked popup does): an app that talks to the window it opened — `postMessage` to
  it, `close()` — can't. netsim doesn't; its windows meet through the lobby.
- **A server on another port that isn't HTTP is out of reach of a preview.** war2's dev loop runs a WebSocket
  signaling server on :9000 beside Vite; a preview's `ws://localhost:9000` goes to the real network (through the
  capability gate), where nothing in the editor listens. Untried with war2 itself; the editor serves only HTTP
  servers (`/__virtual__/<port>/`).
- **netsim itself across editor windows is checked only by hand.** `play.test.ts` plays across tabs of a plain
  browser; the editor's architecture fixture now plays a tiny lobby like netsim's (editor `b4206eb`) (a Web Lock picks
  the host, a BroadcastChannel carries hello/welcome) across two preview windows on one server — the primitives
  netsim's lobby rests on — but nothing runs netsim's own lobby in editor windows automatically (editor CI has no
  netsim to load).
- **In the editor's terminal, an interrupted command's own `cd` doesn't stick**: after `cd games/netsim && vite` and
  Ctrl-C you're still where you started (a desktop shell would have you in `games/netsim`). An interrupted run never
  reaches the terminal's `$PWD` probe, the only way a `cd` reaches it.

### editor CI (`editor/components/monaco-vscode-api`, `editor/packages/vscode`)

- **A package can't use a sibling's new export in the push that adds it.** observability and debug-mcp test against
  hub's *published* tarball (a devDependency), and the editor publishes only once CI passes — so importing a hub export
  added in the same push fails CI, and nothing publishes (hit with `rpcCallSubject`, editor `bc719af`). Ship the export
  first, or have the packages' tests resolve siblings from source (a `link:` devDependency would, since node then
  strips types at the real path outside node_modules).

- **The editor's lint only passes when the monaco-vscode-api demo is installed** (the component's `install.sh` sets it
  up; it can come up empty when upstream tags a release before publishing it to npm, as on 2026-09-30). `packages/vscode`'s extensions import `"vscode"`,
  and in the root-tsconfig program the only thing that satisfies it is the demo's
  `node_modules/@codingame/monaco-vscode-api/vscode-dts/vscode.d.ts` (an ambient `declare module "vscode"`). Without
  it, TypeScript resolves `"vscode"` as a self-reference to the editor's own package (named `vscode`, exporting
  `vscode.tsx`), and `Uri` / `TextDocument` / `Disposable` become error types (`ts/no-redundant-type-constituents`).
  A `paths` entry for `vscode` (to `@types/vscode`), or not naming the workspace package `vscode`, would decouple it.

### lib / tooling

- **TypeScript `latest` is 7.0, which typescript-eslint doesn't support yet.** The games repo pins `^6.0.3`.
- **Browser code isn't measured for coverage.** `src/browser/**` is excluded from the node coverage run, and
  Playwright's coverage API covers pages but not workers (where the referee and clients run). Needs V8 coverage
  collected per target over CDP (or instrumented builds reporting over the hub).
- **A fresh `pnpm install --ignore-workspace` of an editor package links nothing at the top level** (pnpm 12 writes a
  `.package-map.json` instead), so plain `node` can't resolve its dependencies. The packages are installed with npm
  locally (flat); a reused pnpm store also serves a stale copy of a mutable `@latest.tgz`.
- **util's Vite is a peer dependency**: an app using `util/vite/*` must declare `vite` itself (pnpm won't hoist it).

## Fixed

- **The preview tap was a side channel, and netsim had two transports** (the simplification audit, step 4). The
  editor's page tap is now a hub client: a preview window's top frame holds its one hub into the editor (the tap's,
  named as the window), the app's own hub joins through it (observability's `linkPreviewHost`), and console records,
  capability requests (`preview.decide`) and new windows (`preview.open`) ride it — the shell takes the window from the
  link, and the ad-hoc `obs-log` / `cap-decide` / `open-window` protocol is gone (workers keep a BroadcastChannel tap:
  they can't reach the editor's window). netsim links every client to the referee over a BroadcastChannel — the host's
  own too — carrying only the game (permissions: lobby, seat, host); each client is observed and debugged through its
  own tab (page ─ instance ─ worker), so the host inspects its own players, not another tab's (`netsim_divergence`
  says which are elsewhere). It found a hub gap: a confined link still advertised interest its permissions would
  refuse, so a page took a player's debug RPC for reachable and waited out a timeout — hub now advertises only what
  each link could deliver. And the editor's architecture CI tested this commit's editor against the *published*
  observability (a race with its publish): it now packs this commit's hub and observability for the fixture.

- **Identity was guessed downstream** (the simplification audit, step 3). One naming rule now: the edge names. The hub
  where an app joins a tree (the editor's shell per preview window, netsim's referee per client, a player tab's
  instance) renames what comes across (observability's `scopedTransport`): the hub across the link IS the scope
  (`preview:5173`, `client-0`), the rest under it (`client-0/ui`) — so nothing self-names (the reporter's `self` and
  observe's `source` options are gone) and nothing can pass as another (`observabilityPermissions()` no longer encodes
  ids). Where a context runs is reported, not inferred: the editor's preview tap tags each worker with the page that
  started it and its window (`#realm-parent=…&preview-window=…`), so the view places it and the shell routes its logs
  and capability requests to its window (not the port's last used one). Lifetime: reporters heartbeat while anyone
  listens, and a viewer ends one silent for 15s — with the shell ending a closed window's reporters, that retired the
  view's alias, cross-window and ended inference (`appEnded`). It turned up a real bug: scoping renamed interest frames
  too, so a collector's interest never crossed a scoped edge from the app's side.

- **Observing a context took four calls, and a tab exposed tools three ways** (the simplification audit, step 2).
  observability's `observe(hub, { source, network })` wires a context's logger, uncaught errors and architecture in one
  call, and `observeApp(hub, { tools })` an app's root (collect, then the editor's tree or debug-mcp) — netsim's own
  `telemetry.ts` and the editor's six hand-wired sites use them. Everything a tab exposes is now a page tool
  (`tool.<name>.<tab>`): `page_eval` / `page_query` are built in, and the editor serves its debugger, provoke and CDP
  tools itself — debug-mcp keeps only its own store tools and no longer knows the editor's debugger (observability
  protocol 3). hub's `channelTransport` replaces netsim's copy; observability's `scopedTransport` the editor's
  hand-written one. The reporter's pending-link placeholders went: traffic before a peer's hello is held until the
  hello names it.

- **Test helpers were copied file to file, and wire formats lived as scattered regexes** (the reuse audit). Now: util's
  `until()` (lib, browser-safe) replaces the polling loops — debug-mcp's tests, the editor's architecture harness and
  fixture, netsim's harness and debug-mcp test; util/playwright's `relayWebSocket` replaces the two copies of the
  :7378 relay; the editor's harness launches with `launchChromium`; debug-mcp binds port 0 and says which
  (`whenListening`), and its `testing` export (`connectTestClient`) replaces each test's own MCP client setup and
  `freePort`; hub exports `rpcCallSubject` / `rpcReplySubject` (netsim's permissions use them, and a preview app may
  now reply only to debug-mcp, not `$rpc.reply.>`); the editor's `virtual-path.ts` alone builds and parses
  `/__virtual__/<tab>/<port>/` and `preview:<port>~<n>` (the service worker, the shell, the injected taps, the
  architecture view and fixture). Dead code went with it: hub's `publishWhenInterested`, the pod's unheard
  `editor.ready`, almostnode's tab-less `getServerUrl` / `createFetchHandler`.

- **What the independent review of the multi-window work found** (editor `f7c18fd`, `d066e84`, `20d5b18`, `ef4d7e7`): the RPC client answered
  to its assigned id everywhere, so in the editor a preview page's calls down its own tree (netsim's debug tools) got
  no reply — responders now reply to the call's `from`; any linked hub's `hello` could rename it — only an uplink's
  can; `interested()` counted a link whose permissions would refuse the message; an app hub named `shell` escaped its
  window's scope; a closed preview window's hubs never ended in the architecture view, and a reopened window could
  reuse a closed one's number (and its stale records); the shell's bridge took messages from other origins, and its
  capability prompt with no window open opened a phantom `:5173` window; a worker's injected tap shifted its source
  map by a line and was only recognized at a fixed path depth; the static capability checks and the canary missed fs
  methods the runtime gates (`rm`, `rename`, `copyFile`, …) — all now derive from almostnode's table; an RPC client
  could never stop listening (`dispose()`), and a player that left the lobby kept retrying its connect. The lobby's
  trust model is by design: same-origin tabs are trusted (the editor and a local dev server); a shipped game's
  players meet over WebRTC.

- **A short-lived nested frame's reports sometimes never reached the architecture view** (roughly one run in three) —
  root cause not proven, but the one way a report goes missing is closed: a reporter published even when nothing yet
  listened (a viewer's interest not yet across its links), and that report — its realm, its traffic so far — went
  nowhere. Now it holds reports until someone listens (node ops collapsed if they pile up). The fixture's check reads
  a live frame (editor `c194527`), and if its timeout ever recurs it says what the frame itself saw: whether its reports
  had a listener, and its links. editor `cfef034` — in apps once observability is published.
- **An untrusted peer's hub id had to equal the id its edge assigns**, or its RPC replies couldn't reach it — the edge's
  `hello` now tells the peer the id it assigned (`you`; `Hub.knownAs()`), taken only from the peer's uplink
  (`LinkOptions.uplink`: a child can't rename its parent), and a responder replies to the call's `from` — the id the
  caller's edge stamped — so a hub its uplink named still calls down its own tree. editor `90dfd6a`, `f7c18fd`; netsim's client
  workers no longer get their id at all — they take it from the referee's hello (for their subjects; their observability
  is named by the edge — see the identity entry above).
- **An app in a preview shared its editor tab's log stream in debug-mcp** — a preview app's tab now names its scope (its
  window, the id the shell assigned its page), and `query_logs` / `query_spans` for that tab return only that window's
  records. editor `181d005`. Both reach apps once hub and observability are published.
- **Observability fixes netsim turned up** (editor `512b5fa`): an unhandled worker error was reported twice — `ownWorker`
  now lives in observability; `observabilityPermissions(peer)` moved in too (netsim uses both); `page_eval`'s `eval`
  alias made every consumer's build warn — it evaluates through `globalThis.eval`;
  the collectors tagged a record by the source it claimed — they tag by its subject, which permissions enforce.
- **A running debug-mcp didn't say it was outdated** — pages now announce an observability protocol number, and
  `list_tabs` marks a page newer than the debug-mcp `outdated` (restart it). editor `512b5fa`.
- **A replaced page's hubs stayed in the architecture view as if alive** — a page (or frame) reports itself ended as it
  goes, and the view fades it and what ran under it (its workers, which can't say so); a reload brings the page back.
  editor `512b5fa`, `4e381ba` (in apps once observability is published).
- **The editor's tap didn't reach a preview's workers** — a worker's entry script now gets a worker tap (console,
  errors, WebSocket gating) reporting to the editor over a BroadcastChannel. editor `b4206eb`.
- **Capability prompts went to a port's last used window** — the WebSocket/WebRTC shim's decisions carry their window
  now; only the service worker's gate (which sees just the address) still goes by port. editor `b4206eb`.
- **The hub and debug-mcp tarballs were untyped** (and a local `util-publish` run left `.d.ts` files in the source
  tree) — util-publish pairs every entry with its declaration and emits outside the tree. lib `058dfc8` (in the tarballs
  once util is released and the packages republished).
- **util's dev server couldn't be owned by a test, and `util-dev` was fixed to 5173** — `serve()` resolves with
  `{ url, port, close }` (port 0: any free port); `util-dev --port` / `$PORT`. lib `7f3bf4a`.
- **No shared test launcher** — `util/playwright/chromium.ts`'s `launchChromium()` (CHROME_PATH → Playwright's →
  system Chrome → newest cached), no scraping machinery or Vite. lib `4433024` (netsim's harness uses it).
- **netsim's `npm run dev` couldn't run in the editor** — it was `node scripts/dev.ts` (util's `serve`), and the editor's
  terminal starts a preview only through its own `vite`. Now it's plain `vite --port 5180` — the same dev server on a
  desktop (netsim's browser tests pass against it) and, in the editor, its `vite` (which ignores the port).
- **The editor's terminal lost its directory after a Ctrl-C** — a new terminal's first command interrupted (`vite`,
  Ctrl-C) sent the next command, and the prompt, to `/home/user`: just-bash hands an interrupted run back its default
  env, and its `PWD` beat the session's directory. The session now seeds `PWD` from its own directory on every run
  (and reports a command's real exit code, which the probe always captured). editor `4020110`.
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
  their realm (window/frame/worker, URL, parent URL) so the view can place them (a worker's parent is now reported too —
  the identity entry above). editor `bc86c8a`, `6f3e6fe`.
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
