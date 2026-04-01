import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/index": "src/cli/index.ts",
    "frameworks/hono": "src/frameworks/hono.ts",
    "frameworks/koa": "src/frameworks/koa.ts",
    "frameworks/express": "src/frameworks/express.ts",
    "frameworks/elysia": "src/frameworks/elysia.ts",
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
