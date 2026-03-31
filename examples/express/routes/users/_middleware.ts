import { createMiddleware } from "routed";

export default createMiddleware(async ({ ctx, next }) => {
  console.log(`[users middleware] scoped to /users`);
  await next();
});
