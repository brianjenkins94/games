import { defineConfig } from "vite";
import { almostnodePlugin } from "almostnode/vite";

export default defineConfig({
    "experimental": {
        "renderBuiltUrl": function(filename, { type }) {
            return type === "asset" ? `/assets/war2/${filename.replace(/^assets\//, "")}` : undefined;
        },
    },
    "plugins": [
        almostnodePlugin(),
        {
            "name": "external-assets",
            "generateBundle": function(options, bundle) {
                for (const key of Object.keys(bundle)) {
                    if (bundle[key].type === "asset") {
                        delete bundle[key];
                    }
                }
            }
        }
    ]
});
