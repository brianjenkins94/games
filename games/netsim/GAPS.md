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

### observability / debug-mcp (`editor/packages/observability`, `editor/packages/debug-mcp`)

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

### lib / tooling

- **`util-dev` is fixed to port 5173**, which the editor's dev server uses; netsim calls `serve(cwd, 5180)` itself.
- **TypeScript `latest` is 7.0, which typescript-eslint doesn't support yet.** The games repo pins `^6.0.3`.
- **util's Vite is a peer dependency**: an app using `util/vite/*` must declare `vite` itself (pnpm won't hoist it).

## Fixed

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
