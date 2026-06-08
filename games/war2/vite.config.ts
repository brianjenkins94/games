import { defineConfig } from "vite";

export default defineConfig({
    experimental: {
        renderBuiltUrl(filename, { type }) {
            return type === "asset" ? `/assets/war2/${filename.replace(/^assets\//, "")}` : undefined;
        },
    },
    plugins: [
        {
            name: "external-assets",
            generateBundle: function(_options, bundle) {
                for (const key of Object.keys(bundle)) {
                    if (bundle[key].type === "asset") {
                        delete bundle[key];
                    }
                }
            },
        },
    ],
});
