import { createExpressApp } from "routed/express";
import { routeTree } from "./routed.gen.ts";

const app = createExpressApp(routeTree);

app.listen(3444, () => {
  console.log("Express example server running on http://localhost:3444");
});
