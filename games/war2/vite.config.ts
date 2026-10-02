/** war2's vite config, merged into util's app build (and the dev server): Phaser's minified ESM build, as the old war2
 *  loaded `phaser.min.js` — war2's own code stays unminified (util's default), but Phaser's 7 MB of source needn't. */
import * as path from "node:path";

export default {
	"resolve": { "alias": { "phaser": path.resolve(import.meta.dirname, "node_modules/phaser/dist/phaser.esm.min.js") } }
};
