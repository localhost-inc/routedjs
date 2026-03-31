import { createRoute } from "routedjs";
import { z } from "zod";

export default createRoute({
  schemas: {
    params: z.object({
      userId: z.string(),
    }),
  },
  handler: async ({ params }) => {
    return {
      visits: [
        { id: "v1", userId: params.userId, date: "2026-03-30" },
      ],
    };
  },
});
