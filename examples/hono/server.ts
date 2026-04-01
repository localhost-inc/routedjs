import { app } from "./routed.gen.ts";

export type { AppType } from "./routed.gen.ts";

export default {
  fetch: app.fetch,
  port: 3111,
};

console.log("Example server running on http://localhost:3111");
