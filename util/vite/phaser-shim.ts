// Shared Phaser shim for all games.
//
// Each game's HTML loads Phaser 4 via a <script> CDN tag, which sets
// globalThis.Phaser before any module code runs. The build aliases the bare
// "phaser" specifier to this file, so `import Phaser from "phaser"` resolves to
// the CDN global — Phaser is never bundled, and the same import works in every
// game without a renderChunk transform or per-game config.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default (globalThis as any).Phaser;
