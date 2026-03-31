# routed

File-system routing for APIs. Drop a file, get an endpoint.

Your file tree is your routing table. No manual route registration, no path strings to keep in sync. Routed scans your routes directory, derives URL paths from the file system, and generates a framework-agnostic route manifest. Adapters wire it into the framework of your choice.

```
routes/
  health.get.route.ts              → GET  /health
  users/
    index.get.route.ts             → GET  /users
    index.post.route.ts            → POST /users
    $userId.get.route.ts           → GET  /users/:userId
    $userId.put.route.ts           → PUT  /users/:userId
    $userId.delete.route.ts        → DELETE /users/:userId
    $userId/
      visits.get.route.ts          → GET  /users/:userId/visits
      visits/$visitId.get.route.ts → GET  /users/:userId/visits/:visitId
```

## Install

```bash
bun add routed
# + your framework + your validator
bun add hono    # or koa, express, elysia
bun add zod     # or valibot, arktype, or any Standard Schema validator
```

## Quick start

### 1. Define a route

```ts
// routes/users/$userId.get.route.ts
import { createRoute } from "routed";
import { z } from "zod";

export default createRoute({
  schemas: {
    params: z.object({ userId: z.string().uuid() }),
  },
  handler: async ({ params }) => {
    return { id: params.userId, name: "Kyle" };
  },
});
```

No `method`. No `path`. Both are derived from the filename and location.

### 2. Add config

```ts
// routed.config.ts
import { defineConfig } from "routed";

export default defineConfig({
  routesDir: "./routes",
  outFile: "./routed.gen.ts",
  dev: {
    command: "bun run server.ts",
  },
});
```

### 3. Generate

```bash
routed generate
```

This scans your routes directory and writes `routed.gen.ts` — a framework-agnostic route manifest:

```ts
// routed.gen.ts (auto-generated)
import { defineRouteTree } from "routed";
import route0 from "./routes/users/$userId.get.route.ts";

export const routeTree = defineRouteTree([
  { path: "/users/:userId", method: "get", route: route0, middleware: [] },
]);
```

### 4. Serve

Pick an adapter and create your server:

```ts
// server.ts
import { createHonoApp } from "routed/hono";
import { routeTree } from "./routed.gen";

const app = createHonoApp(routeTree);

export default { fetch: app.fetch, port: 3000 };
```

That's it. The same route files work with any adapter — swap `routed/hono` for `routed/koa`, `routed/express`, or `routed/elysia` and nothing else changes.

## File conventions

| Pattern | URL | Notes |
|---------|-----|-------|
| `index.get.route.ts` | `/` | `index` maps to directory root |
| `users/index.get.route.ts` | `/users` | |
| `users/$userId.get.route.ts` | `/users/:userId` | `$` prefix = dynamic param |
| `_admin/users.get.route.ts` | `/users` | `_` prefix on dirs = pathless group |
| `_middleware.ts` | — | Directory-scoped middleware |

**Filename format**: `{segment}.{method}.route.ts`

Supported methods: `get`, `post`, `put`, `patch`, `delete`

## Middleware

### Per-route

```ts
// routes/users/$userId.get.route.ts
import { createRoute } from "routed";
import { authMiddleware } from "../_middleware";

export default createRoute({
  middleware: [authMiddleware],
  handler: async ({ params }) => { ... },
});
```

### Directory-scoped

Create a `_middleware.ts` in any directory. It applies to all routes in that directory and below.

```ts
// routes/users/_middleware.ts
import { createMiddleware } from "routed";

export default createMiddleware(async ({ ctx, next }) => {
  console.log("runs before all /users/* routes");
  await next();
});
```

Middleware stacks root-first: root `_middleware.ts` runs first, then nested directories, then per-route middleware, then the handler.

## Validation

Schemas are optional and work with any [Standard Schema](https://standardschema.dev/) validator — Zod, Valibot, ArkType, or anything else that implements the spec. When provided, the adapter validates automatically and returns 400 with structured errors on failure.

```ts
import { z } from "zod"; // or valibot, arktype, etc.

export default createRoute({
  schemas: {
    params: z.object({ userId: z.string().uuid() }),
    query: z.object({ limit: z.coerce.number().optional() }),
    body: z.object({ name: z.string(), email: z.string().email() }),
    response: z.object({ id: z.string() }),
  },
  handler: async ({ params, query, body }) => {
    // params, query, body are typed and validated
    return { id: params.userId };
  },
});
```

## Adapters

Routed ships adapters for four frameworks. The route tree is framework-agnostic — adapters translate it into framework-specific registration.

### Hono

```ts
import { createHonoApp } from "routed/hono";
const app = createHonoApp(routeTree);
export default { fetch: app.fetch, port: 3000 };
```

### Koa

```ts
import { createKoaApp } from "routed/koa";
const app = createKoaApp(routeTree);
app.listen(3000);
```

### Express

```ts
import { createExpressApp } from "routed/express";
const app = createExpressApp(routeTree);
app.listen(3000);
```

### Elysia

```ts
import { createElysiaApp } from "routed/elysia";
const app = createElysiaApp(routeTree);
app.listen(3000);
```

## Type-safe client

Routed can generate a fully typed API client from your route definitions. Add `client` to your config:

```ts
// routed.config.ts
export default defineConfig({
  routesDir: "./routes",
  outFile: "./routed.gen.ts",
  client: {
    outFile: "./routed.client.ts",
  },
});
```

Run `routed generate` and use the client:

```ts
import { createApiClient } from "./routed.client";

const api = createApiClient({ baseUrl: "http://localhost:3000" });

// Fully typed — params, query, body, and response
const { data } = await api.users[":userId"].get({
  params: { userId: "abc-123" },
});
// data: { id: string, name: string }
```

Types are inferred from your schemas at compile time. At runtime, the client is a thin wrapper around `fetch` — no runtime code generation, just typed HTTP calls.

## Response validation

Adapters can optionally validate handler return values against your `response` schema. Off by default — enable it to catch handler bugs during development:

```ts
const app = createHonoApp(routeTree, { validateResponses: true });
```

When enabled, if a handler returns data that doesn't match the response schema, the adapter throws a 500 with the validation issues. Available on all four adapters.

## OpenAPI

Routed generates OpenAPI 3.1 specs from your route schemas and metadata:

```ts
import { generateOpenAPISpec } from "routed/openapi";

const spec = generateOpenAPISpec(routeTree, {
  info: { title: "My API", version: "1.0.0" },
});
```

Or from the CLI — add `openapi` to your config:

```ts
// routed.config.ts
export default defineConfig({
  routesDir: "./routes",
  outFile: "./routed.gen.ts",
  openapi: {
    title: "My API",
    version: "1.0.0",
    outFile: "./openapi.json",
  },
});
```

```bash
routed openapi
# → writes openapi.json
```

## CLI

### `routed generate`

One-shot codegen. Scans your routes directory and writes the manifest (and client, if configured).

### `routed dev`

Watches your source directory, regenerates the manifest when route files change, and restarts your server on any file change. One command, one watcher, no duplication.

```bash
routed dev
# → generates routed.gen.ts
# → spawns: bun run server.ts
# → watching for changes...
```

The server command comes from `dev.command` in your config.

### `routed openapi`

Generates an OpenAPI spec from your routes. Requires `openapi` in your config.

## Benchmarks

All four adapters benchmarked over real HTTP on Apple M2 Max (bun 1.3.10):

**Request throughput (avg µs/req, lower is better)**:

| Scenario | Hono | Elysia | Express | Koa |
|----------|------|--------|---------|-----|
| Static route | 66 | 44 | 57 | 73 |
| + 2 middleware | 52 | 48 | 69 | 59 |
| Dynamic param | 48 | 53 | 59 | 61 |
| + body validation | 63 | 74 | 92 | 105 |

Run benchmarks locally:

```bash
bun run bench
```

## License

MIT
