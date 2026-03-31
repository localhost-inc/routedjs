import { createRoute } from "routed";
import { auth } from "../../middleware/auth.ts";

export default createRoute({
  middleware: [auth],
  handler: async ({ ctx }) => {
    const user = ctx.get("user"); // inferred as User from auth middleware
    return { id: user.id, name: user.name, role: user.role };
  },
});
