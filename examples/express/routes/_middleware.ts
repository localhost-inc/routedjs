import { createMiddleware } from "routed";

export default createMiddleware(async ({ ctx, next }) => {
  console.log(`[root middleware] request received`);
  await next();
});
