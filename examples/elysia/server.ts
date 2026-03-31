import { createElysiaApp } from "routed/elysia";
import { routeTree } from "./routed.gen.ts";

const app = createElysiaApp(routeTree);

app.listen(3333);

console.log("Elysia example server running on http://localhost:3333");
