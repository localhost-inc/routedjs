import { createRoute } from "routedjs";

export default createRoute({
  handler: async () => {
    return { status: "ok" };
  },
});
