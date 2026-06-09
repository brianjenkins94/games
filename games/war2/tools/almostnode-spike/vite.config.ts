import { defineConfig } from "vite";
import { almostnodePlugin } from "almostnode/vite";

// Plain Vite, isolated from war2's custom dev pipeline. The almostnode plugin
// serves the service worker at /__sw__.js so getServerBridge().initServiceWorker()
// has something to register.
export default defineConfig({
    plugins: [almostnodePlugin()],
    server: { port: 5180 },
});
