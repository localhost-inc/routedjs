import { createRoute } from "routedjs";

export default createRoute({
  handler: async () => {
    return { uptime: process.uptime(), memory: process.memoryUsage().rss };
  },
});
