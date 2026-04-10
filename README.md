# routed

File-system routing for APIs. Drop a file, get an endpoint.

Your file tree is your routing table. No manual route registration, no path strings to keep in sync. Routed scans your routes directory, derives URL paths from the file system, and generates a framework-agnostic route manifest. Frameworks are supported via codegen — set your framework and get a native, typed app.

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
bun add routedjs
# + your framework + your validator
bun add hono    # or koa, express, elysia
bun add zod     # or valibot, arktype, or any Standard Schema validator
```

## Quick start

### 1. Define a route

```ts
// routes/users/$userId.get.route.ts
import { createRoute } from "routedjs";
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
import { defineConfig } from "routedjs";

export default defineConfig({
  routesDir: "./routes",
  outFile: "./routed.gen.ts",
  framework: "hono",
  dev: {
    command: "bun run server.ts",
  },
});
```

### 3. Generate

```bash
routed generate
```

This scans your routes directory and writes `routed.gen.ts` with both the shared `routeTree` manifest and a native, fully typed app for your framework:

```ts
// routed.gen.ts (auto-generated)
import { defineRouteTree } from "routedjs";
import { Hono } from "hono";
import { routeHandler, wrapMiddleware } from "routedjs/hono";
import route0 from "./routes/users/$userId.get.route.ts";

export const routeTree = defineRouteTree([
  {
    path: "/users/:userId",
    method: "get",
    route: route0,
    middleware: [],
  },
]);

export const app = new Hono()
  .get("/users/:userId", routeHandler(route0, "/users/:userId"));

export type AppType = typeof app;
```

### 4. Serve

```ts
// server.ts
import { app } from "./routed.gen";

export default { fetch: app.fetch, port: 3000 };
```

That's it. The generated app is a native Hono/Express/Koa/Elysia app — fully typed, ready to use. Change `framework` in your config to switch frameworks; the route files stay the same.

## File conventions

| Pattern | URL | Notes |
|---------|-----|-------|
| `index.get.route.ts` | `/` | `index` maps to directory root |
| `users/index.get.route.ts` | `/users` | |
| `users/$userId.get.route.ts` | `/users/:userId` | `$` prefix = dynamic param |
| `storage/$$path.get.route.ts` | `/storage/:path*` | `$$` prefix = catch-all, final segment only |
| `_admin/users.get.route.ts` | `/users` | `_` prefix on dirs = pathless group |
| `_middleware.ts` | — | Directory-scoped middleware |

**Filename format**: `{segment}.{method}.route.ts`

Supported methods: `get`, `post`, `put`, `patch`, `delete`

Catch-all segments use `$$name` and must be the final route segment. When you validate `params` for a catch-all route, model it as `string[]`. routedjs preserves segment boundaries, so a client param like `["docs/v1", "openapi.json"]` round-trips correctly.

## Middleware

### Per-route

```ts
// routes/users/$userId.get.route.ts
import { createRoute } from "routedjs";
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
import { createMiddleware } from "routedjs";

export default createMiddleware(async ({ ctx, next }) => {
  console.log("runs before all /users/* routes");
  await next();
});
```

Middleware stacks root-first: root `_middleware.ts` runs first, then nested directories, then per-route middleware, then the handler.

If a middleware adds typed state, pass that as the first generic to
`createMiddleware<TProvides>()`. If it depends on state from an earlier
middleware, pass the required state as the second generic:

```ts
import { createMiddleware, createRoute } from "routedjs";

const auth = createMiddleware<{ user: { id: string } }>(async ({ ctx, next }) => {
  ctx.set("user", { id: "123" });
  await next();
});

const subject = createMiddleware<
  { subjectId: string },
  { user: { id: string } }
>(async ({ ctx, next }) => {
  ctx.set("subjectId", ctx.get("user").id);
  await next();
});

export default createRoute({
  middleware: [auth, subject],
  handler: ({ ctx }) => ({
    userId: ctx.get("user").id,
    subjectId: ctx.get("subjectId"),
  }),
});
```

Middleware order is type-checked, so `subject` cannot be listed before `auth`.

## Validation

Schemas are optional and work with any [Standard Schema](https://standardschema.dev/) validator — Zod, Valibot, ArkType, or anything else that implements the spec. When provided, routedjs validates automatically and returns 400 with structured errors on failure.

```ts
import { z } from "zod"; // or valibot, arktype, etc.

export default createRoute({
  schemas: {
    params: z.object({ userId: z.string().uuid() }),
    query: z.object({ limit: z.coerce.number().optional() }),
    body: z.object({ name: z.string(), email: z.string().email() }),
    responses: {
      200: z.object({ id: z.string() }),
      404: z.object({ error: z.string() }),
    },
  },
  handler: async ({ params, query, body }) => {
    // params, query, body are typed and validated
    return { id: params.userId };
  },
});
```

## Route context

Handlers and middleware receive a framework-agnostic `ctx`:

- `ctx.request`: standard Web `Request`
- `ctx.status(code)` and `ctx.setHeader(name, value)`: set status/headers for plain-object returns
- `ctx.json(...)`, `ctx.text(...)`, `ctx.redirect(...)`: return a `Response` directly
- `ctx.raw`: underlying framework request/response context

```ts
export default createRoute({
  handler: async ({ ctx }) => {
    ctx.status(201);
    ctx.setHeader("x-created", "yes");
    return { ok: true };
  },
});
```

`ctx.request` works the same way across frameworks, including request-body reads:

```ts
export default createRoute({
  handler: async ({ ctx }) => {
    const bodyText = await ctx.request.text();
    return ctx.text(bodyText);
  },
});
```

If you need full control, return a raw `Response`. Status, headers, binary bodies, redirects, and streaming responses pass through unchanged.

## App context typing

If your app seeds always-present values like `db`, `cache`, or `logger` at the
app level, you can register that context once and get typed `ctx.get(...)`
access in handlers and middleware without repeating a bridge middleware on every
route.

```ts
// app/routed.d.ts
import "routedjs";

declare module "routedjs" {
  interface Register {
    appContext: {
      db: {
        query: (sql: string) => Promise<unknown>;
      };
      cache: {
        get: (key: string) => Promise<string | null>;
      };
    };
  }
}
```

Then your routes can read that context directly:

```ts
import { createRoute } from "routedjs";

export default createRoute({
  handler: async ({ ctx }) => {
    const cached = await ctx.get("cache").get("health");
    if (cached) return { status: cached };

    await ctx.get("db").query("select 1");
    return { status: "ok" };
  },
});
```

On Hono, routed automatically bridges app-level `c.set(...)` / `c.get(...)`
values into routed `ctx.get(...)`, and mirrors routed `ctx.set(...)` back to
the underlying Hono context. Other frameworks can provide equivalent runtime
state through global or directory middleware.

## Frameworks

Set `framework` in your config and `routed generate` produces a native, typed app for that framework while still exporting the shared `routeTree`. Your route files stay the same — only the generated output changes.

### Hono

```ts
// routed.config.ts
framework: "hono"

// server.ts
import { app } from "./routed.gen";
export default { fetch: app.fetch, port: 3000 };
```

The generated Hono app preserves Hono client inference for `json` request bodies,
query params, and typed `await res.json()` responses.

### Express

```ts
// routed.config.ts
framework: "express"

// server.ts
import { app } from "./routed.gen";
app.listen(3000);
```

### Koa

```ts
// routed.config.ts
framework: "koa"

// server.ts
import { app } from "./routed.gen";
app.listen(3000);
```

### Elysia

```ts
// routed.config.ts
framework: "elysia"

// server.ts
import { app } from "./routed.gen";
app.listen(3000);
```

### Without `framework` (generic route tree only)

If you omit `framework`, the generated file exports just the framework-agnostic `routeTree` that you wire into any framework at runtime:

```ts
import { createHonoApp } from "routedjs/hono";
import { routeTree } from "./routed.gen";
const app = createHonoApp(routeTree);
```

This still works but produces an untyped app — use `framework` for full type inference.

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

const file = await api.storage[":path*"].get({
  params: { path: ["docs", "api", "openapi.json"] },
});
```

Types are inferred from your schemas at compile time. At runtime, the client is a thin wrapper around `fetch` — no runtime code generation, just typed HTTP calls.

## Response validation

Adapters can optionally validate handler return values against your `responses` schemas. Off by default — enable it to catch handler bugs during development. Pass `validateResponses` when using the runtime API:

```ts
import { createHonoApp } from "routedjs/hono";
const app = createHonoApp(routeTree, { validateResponses: true });
```

When enabled, routedjs validates plain-object returns against the schema matching the buffered response status. Available on all four frameworks.

## OpenAPI

Routed generates OpenAPI specs from your route schemas and metadata. It defaults to OpenAPI `3.1.0`, and can also emit `3.0.3` when you need a 3.0-compatible consumer:

```ts
import { generateOpenAPISpec } from "routedjs/openapi";

const spec = generateOpenAPISpec(routeTree, {
  info: { title: "My API", version: "1.0.0" },
  specVersion: "3.0.3",
});
```

OpenAPI metadata lives on `meta` in `createRoute`, including `summary`, `description`, `tags`, `deprecated`, and `operationId`.

```ts
import { createRoute } from "routedjs";
import { z } from "zod";

export default createRoute({
  meta: {
    summary: "Get user by ID",
    tags: ["users"],
    operationId: "getUser",
  },
  schemas: {
    params: z.object({ userId: z.string().uuid() }),
    responses: {
      200: z.object({ id: z.string(), name: z.string() }),
      404: z.object({ error: z.string() }),
    },
  },
  handler: async ({ params }) => ({ id: params.userId, name: "Kyle" }),
});
```

If you're using Zod schemas for OpenAPI generation, install `zod-to-json-schema` as well:

```bash
bun add zod-to-json-schema
```

Catch-all routes are represented in OpenAPI as a single slash-delimited `string` path parameter because OpenAPI path params cannot accurately express a segment array.

Or from the CLI — add `openapi` to your config:

```ts
// routed.config.ts
export default defineConfig({
  routesDir: "./routes",
  outFile: "./routed.gen.ts",
  openapi: {
    title: "My API",
    version: "1.0.0",
    specVersion: "3.0.3",
    outFile: "./openapi.json",
  },
});
```

```bash
routed openapi
# → writes openapi.json
```

Use `specVersion: "3.0.3"` for generators that expect OpenAPI 3.0 nullable semantics. Leave it unset to emit `3.1.0` with JSON Schema draft 2020-12 output.

## CLI

### `routed generate`

One-shot codegen. Scans your routes directory and writes `routeTree`, plus a typed framework app when `framework` is configured (and client output, if configured).

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

### `bun run examples:generate`

Regenerates the checked-in `examples/*/routed.gen.ts` files. This also runs automatically during `prepublishOnly` so example output stays in sync with the current generator.

## Benchmarks

All four frameworks benchmarked over real HTTP on Apple M2 Max (bun 1.3.10):

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
