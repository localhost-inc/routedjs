import { createHonoApp } from "routed/hono";
import { routeTree } from "./routed.gen.ts";

const app = createHonoApp(routeTree);

export default {
  fetch: app.fetch,
  port: 3111,
};

console.log("Example server running on http://localhost:3111");
