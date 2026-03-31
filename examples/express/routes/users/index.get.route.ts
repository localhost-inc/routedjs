import { createRoute } from "routedjs";

export default createRoute({
  handler: async () => {
    return {
      users: [
        { id: "1", name: "Kyle" },
        { id: "2", name: "Alex" },
      ],
    };
  },
});
