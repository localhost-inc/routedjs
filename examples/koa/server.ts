import { createKoaApp } from "routed/koa";
import { routeTree } from "./routed.gen.ts";

const app = createKoaApp(routeTree);

app.listen(3222, () => {
  console.log("Koa example server running on http://localhost:3222");
});
