import { createRoute } from "routed";
import { z } from "zod";

export default createRoute({
  schemas: {
    params: z.object({ userId: z.string() }),
  },
  handler: async ({ params }) => {
    return { id: params.userId, deleted: true };
  },
});
