/** `npm run dev`: serve netsim with util's shared Vite dev server (util-dev is fixed to port 5173). */
import { serve } from "@brianjenkins94/util/vite/dev";

await serve(process.cwd(), Number(process.env["PORT"]) || 5180);
