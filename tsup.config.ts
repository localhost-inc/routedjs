import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/hono": "src/adapters/hono.ts",
    "adapters/koa": "src/adapters/koa.ts",
    "adapters/express": "src/adapters/express.ts",
    "adapters/elysia": "src/adapters/elysia.ts",
    "openapi/index": "src/openapi/index.ts",
    "client/index": "src/client/index.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: true,
  clean: true,
  external: [
    "hono",
    "koa",
    "express",
    "elysia",
    "zod",
    "zod-to-json-schema",
    "chokidar",
  ],
});
