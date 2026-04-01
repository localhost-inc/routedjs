import { defineConfig } from "../../src/index.ts";

export default defineConfig({
  routesDir: "./routes",
  outFile: "./routed.gen.ts",
  framework: "elysia",
  dev: {
    command: "bun run server.ts",
  },
});
