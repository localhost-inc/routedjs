import { createMiddleware } from "routedjs";

export default createMiddleware(async ({ ctx, next }) => {
  console.log(`[users middleware] scoped to /users`);
  await next();
});
