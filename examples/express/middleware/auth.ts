import { createMiddleware, RouteError } from "routed";

type User = { id: string; name: string; role: string };

export const auth = createMiddleware<{ user: User }>(async ({ ctx, next }) => {
  const token = ctx.header("authorization");
  if (!token || !token.startsWith("Bearer ")) {
    throw new RouteError(401, "Unauthorized");
  }

  // Simulate resolving a user from a token
  const user: User = { id: "u1", name: "Kyle", role: "admin" };
  ctx.set("user", user);
  await next();
});
