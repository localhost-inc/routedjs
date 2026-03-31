import { createRoute } from "routed";

export default createRoute({
  handler: async () => {
    return { status: "ok" };
  },
});
