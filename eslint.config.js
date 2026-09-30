import config from "@brianjenkins94/util/eslint";

export default [
	...config,
	{ "ignores": ["docs/**", "dist/**", "coverage/**", "**/assets/**"] }
];
