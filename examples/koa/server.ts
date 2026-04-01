import { app } from "./routed.gen.ts";

app.listen(3222, () => {
  console.log("Koa example server running on http://localhost:3222");
});
