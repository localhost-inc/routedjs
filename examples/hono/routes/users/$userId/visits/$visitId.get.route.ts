import { createRoute } from "routedjs";
import { z } from "zod";

export default createRoute({
  schemas: {
    params: z.object({
      userId: z.string(),
      visitId: z.string(),
    }),
  },
  handler: async ({ params }) => {
    return { userId: params.userId, visitId: params.visitId };
  },
});
