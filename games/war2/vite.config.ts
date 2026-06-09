import { defineConfig } from "vite";
import { almostnodePlugin } from "almostnode/vite";

export default defineConfig({
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
