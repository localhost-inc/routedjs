import { createRoute } from "routed";
import { z } from "zod";

export default createRoute({
  schemas: {
    params: z.object({ userId: z.string() }),
    body: z.object({ name: z.string() }),
  },
  handler: async ({ params, body }) => {
    return { id: params.userId, ...body, updated: true };
  },
});
