import config from "@brianjenkins94/util/eslint";

export default [
	...config,
	// (war2's legacy/ is the old sim, frozen as the oracle's reference — kept verbatim — and its traces are recorded data.)
	{ "ignores": ["docs/**", "dist/**", "coverage/**", "**/assets/**", "games/war2/legacy/**", "games/war2/test/oracle/traces/**"] }
];
