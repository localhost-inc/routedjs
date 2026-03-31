import path from "node:path";
import { bench, group, run } from "mitata";
import { z } from "zod";
import { createRoute } from "../src/core/create-route.ts";
import { createMiddleware } from "../src/core/create-middleware.ts";
import { defineRouteTree } from "../src/core/define-route-tree.ts";
import type { RouteTree, MiddlewareDefinition } from "../src/core/types.ts";
import { createHonoApp } from "../src/adapters/hono.ts";
import { createKoaApp } from "../src/adapters/koa.ts";
import { createElysiaApp } from "../src/adapters/elysia.ts";
import { createExpressApp } from "../src/adapters/express.ts";
import { generate } from "../src/cli/generate.ts";

// ---------------------------------------------------------------------------
// Synthetic route tree
// ---------------------------------------------------------------------------

const noopMiddleware = createMiddleware(async ({ next }) => {
  await next();
});

const logMiddleware = createMiddleware(async ({ next }) => {
  // Simulate a tiny bit of work
  const _start = Date.now();
  await next();
});

const staticRoute = createRoute({
  handler: async () => ({ status: "ok" }),
});

const paramRoute = createRoute({
  schemas: {
    params: z.object({ id: z.string() }),
  },
  handler: async ({ params }) => ({ id: params.id }),
});

const validatedRoute = createRoute({
  schemas: {
    params: z.object({ id: z.string() }),
    body: z.object({
      name: z.string(),
      email: z.string().email(),
      age: z.number().int().min(0).max(150),
    }),
  },
  handler: async ({ params, body }) => ({ id: params.id, ...body }),
});

function buildRouteTree(routeCount: number): RouteTree {
  const entries: RouteTree = [];
  const methods = ["get", "post", "put", "delete"] as const;

  for (let i = 0; i < routeCount; i++) {
    const method = methods[i % methods.length]!;
    entries.push({
      path: `/resource${i}/:id`,
      method,
      route: i % 5 === 0 ? validatedRoute : paramRoute,
      middleware: [noopMiddleware, logMiddleware],
    });
  }

  return defineRouteTree(entries);
}

// Pre-build route trees
const smallTree = buildRouteTree(10);
const mediumTree = buildRouteTree(50);
const largeTree = buildRouteTree(200);

// Focused tree for throughput testing
const throughputTree = defineRouteTree([
  {
    path: "/health",
    method: "get",
    route: staticRoute,
    middleware: [],
  },
  {
    path: "/health-mw",
    method: "get",
    route: staticRoute,
    middleware: [noopMiddleware, logMiddleware],
  },
  {
    path: "/users/:id",
    method: "get",
    route: paramRoute,
    middleware: [noopMiddleware],
  },
  {
    path: "/users/:id",
    method: "put",
    route: validatedRoute,
    middleware: [noopMiddleware, logMiddleware],
  },
]);

// ---------------------------------------------------------------------------
// Codegen
// ---------------------------------------------------------------------------

const exampleRoutesDir = path.resolve(
  import.meta.dir,
  "../examples/hono/routes",
);
const tmpOutFile = path.resolve(import.meta.dir, "../.bench-routed.gen.ts");

group("codegen", () => {
  bench("generate (9 routes)", async () => {
    await generate({ routesDir: exampleRoutesDir, outFile: tmpOutFile });
  });
});

// ---------------------------------------------------------------------------
// App creation
// ---------------------------------------------------------------------------

group("app creation — hono", () => {
  bench("10 routes", () => createHonoApp(smallTree));
  bench("50 routes", () => createHonoApp(mediumTree));
  bench("200 routes", () => createHonoApp(largeTree));
});

group("app creation — koa", () => {
  bench("10 routes", () => createKoaApp(smallTree));
  bench("50 routes", () => createKoaApp(mediumTree));
  bench("200 routes", () => createKoaApp(largeTree));
});

group("app creation — elysia", () => {
  bench("10 routes", () => createElysiaApp(smallTree));
  bench("50 routes", () => createElysiaApp(mediumTree));
  bench("200 routes", () => createElysiaApp(largeTree));
});

group("app creation — express", () => {
  bench("10 routes", () => createExpressApp(smallTree));
  bench("50 routes", () => createExpressApp(mediumTree));
  bench("200 routes", () => createExpressApp(largeTree));
});

// ---------------------------------------------------------------------------
// Throughput (real HTTP for all — fair comparison)
// ---------------------------------------------------------------------------

const honoApp = createHonoApp(throughputTree);
const honoServer = Bun.serve({ fetch: honoApp.fetch, port: 0 });
const honoBase = `http://localhost:${honoServer.port}`;

const koaApp = createKoaApp(throughputTree);
const koaServer = koaApp.listen(0);
const koaPort = (koaServer.address() as { port: number }).port;
const koaBase = `http://localhost:${koaPort}`;

const elysiaApp = createElysiaApp(throughputTree).listen(0);
const elysiaPort = elysiaApp.server!.port;
const elysiaBase = `http://localhost:${elysiaPort}`;

const expressApp = createExpressApp(throughputTree);
const expressServer = expressApp.listen(0);
const expressPort = (expressServer.address() as { port: number }).port;
const expressBase = `http://localhost:${expressPort}`;

const validBody = JSON.stringify({ name: "Kyle", email: "k@k.com", age: 30 });
const putHeaders = { "Content-Type": "application/json" };

group("throughput — static route (no middleware)", () => {
  bench("hono", async () => {
    await fetch(`${honoBase}/health`);
  });
  bench("koa", async () => {
    await fetch(`${koaBase}/health`);
  });
  bench("elysia", async () => {
    await fetch(`${elysiaBase}/health`);
  });
  bench("express", async () => {
    await fetch(`${expressBase}/health`);
  });
});

group("throughput — static route (2 middleware)", () => {
  bench("hono", async () => {
    await fetch(`${honoBase}/health-mw`);
  });
  bench("koa", async () => {
    await fetch(`${koaBase}/health-mw`);
  });
  bench("elysia", async () => {
    await fetch(`${elysiaBase}/health-mw`);
  });
  bench("express", async () => {
    await fetch(`${expressBase}/health-mw`);
  });
});

group("throughput — dynamic param", () => {
  bench("hono", async () => {
    await fetch(`${honoBase}/users/abc123`);
  });
  bench("koa", async () => {
    await fetch(`${koaBase}/users/abc123`);
  });
  bench("elysia", async () => {
    await fetch(`${elysiaBase}/users/abc123`);
  });
  bench("express", async () => {
    await fetch(`${expressBase}/users/abc123`);
  });
});

group("throughput — dynamic param + body validation", () => {
  bench("hono", async () => {
    await fetch(`${honoBase}/users/abc123`, {
      method: "PUT",
      headers: putHeaders,
      body: validBody,
    });
  });
  bench("koa", async () => {
    await fetch(`${koaBase}/users/abc123`, {
      method: "PUT",
      headers: putHeaders,
      body: validBody,
    });
  });
  bench("elysia", async () => {
    await fetch(`${elysiaBase}/users/abc123`, {
      method: "PUT",
      headers: putHeaders,
      body: validBody,
    });
  });
  bench("express", async () => {
    await fetch(`${expressBase}/users/abc123`, {
      method: "PUT",
      headers: putHeaders,
      body: validBody,
    });
  });
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await run();

// Cleanup
honoServer.stop();
koaServer.close();
elysiaApp.stop();
expressServer.close();
try {
  const { unlink } = await import("node:fs/promises");
  await unlink(tmpOutFile);
} catch {}
