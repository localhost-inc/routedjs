import { createRoute } from "routed";
import { z } from "zod";

export default createRoute({
  schemas: {
    body: z.object({
      name: z.string(),
      email: z.string().email(),
    }),
  },
  handler: async ({ body }) => {
    return { id: "3", ...body };
  },
});
