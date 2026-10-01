# war2's old sim, frozen

A verbatim copy of the old war2 sim core, taken 2026-10-01 from the iCloud monorepo (`Code/games/games/war2`, which
has no git history): `src/game`, `src/net/protocol.ts`, the asset JSON the sim reads, and one real map (*Plains of
snow BNE*, the map the old client loaded).

It's here only as the reference W0's oracle runs against (see `../MIGRATION.md` and `../test/oracle/`): the
recorded traces come from it, and W1's new sim has to reproduce them. **Don't edit it** — a change here changes the
reference. It's deleted once W1 matches it.

It uses `const enum` (in `src/net/protocol.ts`), which Node's type stripping can't run and the repo's tsconfig
(`erasableSyntaxOnly`) rejects: it runs under tsx, and a repo-wide `tsc` reports those two lines (CI doesn't run `tsc`).

