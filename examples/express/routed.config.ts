import { defineConfig } from "routed";

export default defineConfig({
  routesDir: "./routes",
  outFile: "./routed.gen.ts",
  dev: {
    command: "bun run server.ts",
  },
});
