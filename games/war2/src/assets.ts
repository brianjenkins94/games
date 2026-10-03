/**
 * Where war2's art and maps come from: the `assets` repo's public Pages mirror, the same source the old war2 used
 * (W3, see MIGRATION.md). Fetched on demand — a map when a match starts on it, a unit's sheet the first time one is
 * drawn — rather than all 164 MB downloaded at install. The metadata the code reads at load (units, sprites,
 * constructions, icons, terrain classes) is committed in `src/data/`.
 */
export const ASSETS = "https://brianjenkins94.github.io/assets/war2/";

/** A mirror path's URL (each segment encoded: names have spaces). */
export function assetUrl(path: string): string {
	return ASSETS + path.split("/").map(encodeURIComponent).join("/");
}
