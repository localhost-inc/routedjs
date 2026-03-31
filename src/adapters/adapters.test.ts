import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { createRoute } from "../core/create-route.ts";
import { createMiddleware } from "../core/create-middleware.ts";
import type { RouteTree, MiddlewareDefinition } from "../core/types.ts";
import { createHonoApp } from "./hono.ts";
import { createKoaApp } from "./koa.ts";
import { createExpressApp } from "./express.ts";
import { createElysiaApp } from "./elysia.ts";

// ---------------------------------------------------------------------------
// Shared middleware-order tracking
// ---------------------------------------------------------------------------

let middlewareOrder: string[] = [];

function makeTrackingMiddleware(label: string): MiddlewareDefinition {
  return createMiddleware(async ({ next }) => {
    middlewareOrder.push(label);
    await next();
  });
}

// ---------------------------------------------------------------------------
// Route tree (shared across all adapters)
// ---------------------------------------------------------------------------

const dirMw1 = makeTrackingMiddleware("dir1");
const dirMw2 = makeTrackingMiddleware("dir2");
const routeMw = makeTrackingMiddleware("route1");
const encoder = new TextEncoder();
const STREAM_DELAY_MS = 200;
const FIRST_CHUNK_TIMEOUT_MS = 120;
const STREAM_BINARY_CHUNK_ONE_SIZE = 128 * 1024;
const STREAM_BINARY_CHUNK_TWO_SIZE = 96 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createChunkedResponse(
  chunks: Uint8Array[],
  headers: Record<string, string>,
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(chunks[0]!);
        await sleep(STREAM_DELAY_MS);
        for (const chunk of chunks.slice(1)) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    { headers },
  );
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function readStreamWithEarlyFirstChunk(
  response: Response,
  timeoutMs: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    throw new Error("Expected streaming response body");
  }

  const reader = body.getReader();
  const firstChunk = await Promise.race([
    reader.read(),
    sleep(timeoutMs).then(() => null),
  ]);

  if (!firstChunk || firstChunk.done) {
    throw new Error(`Expected first chunk within ${timeoutMs}ms`);
  }

  const chunks: Uint8Array[] = [];
  chunks.push(firstChunk.value);
  while (true) {
    const part = await reader.read();
    if (part.done) {
      return concatChunks(chunks);
    }
    chunks.push(part.value);
  }
}

function buildRouteTree(): RouteTree {
  return [
    // GET /health - static, no middleware, no schemas
    {
      path: "/health",
      method: "get",
      route: createRoute({
        handler: async () => ({ status: "ok" }),
      }),
      middleware: [],
    },

    // GET /users - with query schema
    {
      path: "/users",
      method: "get",
      route: createRoute({
        schemas: {
          query: z.object({
            limit: z.coerce.number().optional(),
          }),
        },
        handler: async ({ query }) => ({ users: [], limit: query?.limit }),
      }),
      middleware: [],
    },

    // POST /users - with body schema
    {
      path: "/users",
      method: "post",
      route: createRoute({
        schemas: {
          body: z.object({
            name: z.string(),
            email: z.string().email(),
          }),
        },
        handler: async ({ body }) => ({
          id: "new-1",
          name: body.name,
          email: body.email,
        }),
      }),
      middleware: [],
    },

    // GET /users/:id - with params schema
    {
      path: "/users/:id",
      method: "get",
      route: createRoute({
        schemas: {
          params: z.object({ id: z.string() }),
        },
        handler: async ({ params }) => ({ id: params.id, name: "Alice" }),
      }),
      middleware: [],
    },

    // PUT /users/:id - with params + body schema
    {
      path: "/users/:id",
      method: "put",
      route: createRoute({
        schemas: {
          params: z.object({ id: z.string() }),
          body: z.object({
            name: z.string(),
            email: z.string().email(),
          }),
        },
        handler: async ({ params, body }) => ({
          id: params.id,
          name: body.name,
          email: body.email,
        }),
      }),
      middleware: [],
    },

    // DELETE /users/:id - with params schema
    {
      path: "/users/:id",
      method: "delete",
      route: createRoute({
        schemas: {
          params: z.object({ id: z.string() }),
        },
        handler: async ({ params }) => ({ deleted: params.id }),
      }),
      middleware: [],
    },

    // GET /ordered - 2 directory middleware + 1 per-route middleware
    {
      path: "/ordered",
      method: "get",
      route: createRoute({
        middleware: [routeMw],
        handler: async () => ({ ok: true }),
      }),
      middleware: [dirMw1, dirMw2],
    },

    {
      path: "/created",
      method: "post",
      route: createRoute({
        handler: async ({ ctx }) => {
          ctx.status(201);
          ctx.setHeader("x-created", "yes");
          return { created: true };
        },
      }),
      middleware: [],
    },

    {
      path: "/redirect",
      method: "get",
      route: createRoute({
        handler: async ({ ctx }) => ctx.redirect("https://example.com"),
      }),
      middleware: [],
    },

    {
      path: "/binary",
      method: "get",
      route: createRoute({
        handler: async () =>
          new Response(new Uint8Array([0, 255, 1]), {
            headers: {
              "content-type": "application/octet-stream",
              "x-binary": "yes",
            },
          }),
      }),
      middleware: [],
    },

    {
      path: "/echo-body",
      method: "post",
      route: createRoute({
        handler: async ({ ctx }) => ({
          bodyText: await ctx.request.text(),
        }),
      }),
      middleware: [],
    },

    {
      path: "/stream-text",
      method: "get",
      route: createRoute({
        handler: async () =>
          createChunkedResponse(
            [encoder.encode("hello\n"), encoder.encode("world")],
            { "content-type": "text/plain; charset=utf-8" },
          ),
      }),
      middleware: [],
    },

    {
      path: "/stream-sse",
      method: "get",
      route: createRoute({
        handler: async () =>
          createChunkedResponse(
            [encoder.encode("data: one\n\n"), encoder.encode("data: two\n\n")],
            {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            },
          ),
      }),
      middleware: [],
    },

    {
      path: "/stream-binary",
      method: "get",
      route: createRoute({
        handler: async () =>
          createChunkedResponse(
            [
              new Uint8Array(STREAM_BINARY_CHUNK_ONE_SIZE).fill(7),
              new Uint8Array(STREAM_BINARY_CHUNK_TWO_SIZE).fill(9),
            ],
            {
              "content-type": "application/octet-stream",
              "x-streamed": "yes",
            },
          ),
      }),
      middleware: [],
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MakeRequest = (
  method: string,
  path: string,
  options?: { body?: unknown; headers?: Record<string, string>; redirect?: "follow" | "manual" | "error" },
) => Promise<Response>;

function jsonReq(
  base: string,
  method: string,
  path: string,
  options?: { body?: unknown; headers?: Record<string, string>; redirect?: "follow" | "manual" | "error" },
): Request {
  const url = `${base}${path}`;
  const init: RequestInit = {
    method: method.toUpperCase(),
    headers: { "Content-Type": "application/json", ...options?.headers },
    redirect: options?.redirect,
  };
  if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  return new Request(url, init);
}

// ---------------------------------------------------------------------------
// Adapter-specific setup
// ---------------------------------------------------------------------------

function setupHono(): { makeRequest: MakeRequest; teardown: () => void } {
  const app = createHonoApp(buildRouteTree());
  return {
    makeRequest: async (method, path, options) => {
      const req = jsonReq("http://localhost", method, path, options);
      return app.fetch(req);
    },
    teardown: () => {},
  };
}

function setupKoa(): {
  makeRequest: MakeRequest;
  teardown: () => void;
  start: () => Promise<void>;
} {
  const app = createKoaApp(buildRouteTree());
  let port = 0;
  let server: ReturnType<typeof app.listen>;
  return {
    start: () =>
      new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            port = addr.port;
          }
          resolve();
        });
      }),
    makeRequest: async (method, path, options) => {
      const req = jsonReq(`http://127.0.0.1:${port}`, method, path, options);
      return fetch(req);
    },
    teardown: () => {
      server?.close();
    },
  };
}

function setupExpress(): {
  makeRequest: MakeRequest;
  teardown: () => void;
  start: () => Promise<void>;
} {
  const app = createExpressApp(buildRouteTree());
  let port = 0;
  let server: ReturnType<typeof app.listen>;
  return {
    start: () =>
      new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            port = addr.port;
          }
          resolve();
        });
      }),
    makeRequest: async (method, path, options) => {
      const req = jsonReq(`http://127.0.0.1:${port}`, method, path, options);
      return fetch(req);
    },
    teardown: () => {
      server?.close();
    },
  };
}

function setupElysia(): {
  makeRequest: MakeRequest;
  teardown: () => void;
} {
  const app = createElysiaApp(buildRouteTree());
  return {
    makeRequest: async (method, path, options) => {
      const req = jsonReq("http://localhost", method, path, options);
      return app.handle(req);
    },
    teardown: () => {},
  };
}

// ---------------------------------------------------------------------------
// Shared test cases run for every adapter
// ---------------------------------------------------------------------------

function adapterTests(
  adapterName: string,
  getCtx: () => { makeRequest: MakeRequest },
) {
  test("1. static route returns 200 with correct JSON", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("GET", "/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("ok");
  });

  test("2. dynamic param is extracted correctly", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("GET", "/users/42");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; name: string };
    expect(json.id).toBe("42");
    expect(json.name).toBe("Alice");
  });

  test("3. query params are parsed", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("GET", "/users?limit=10");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { users: unknown[]; limit?: number };
    expect(json.limit).toBe(10);
  });

  test("4. valid body passes validation and handler receives typed body", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("POST", "/users", {
      body: { name: "Bob", email: "bob@example.com" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      id: string;
      name: string;
      email: string;
    };
    expect(json.name).toBe("Bob");
    expect(json.email).toBe("bob@example.com");
    expect(json.id).toBe("new-1");
  });

  test("5. invalid body returns 400 with validation error structure", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("POST", "/users", {
      body: { name: "Bob", email: "not-an-email" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: string;
      target: string;
      issues: unknown[];
    };
    expect(json.error).toBe("Validation failed");
    expect(json.target).toBe("body");
    expect(Array.isArray(json.issues)).toBe(true);
    expect(json.issues.length).toBeGreaterThan(0);
  });

  test("6. missing required body field returns 400", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("POST", "/users", {
      body: { name: "Bob" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: string;
      target: string;
      issues: unknown[];
    };
    expect(json.error).toBe("Validation failed");
    expect(json.target).toBe("body");
    expect(json.issues.length).toBeGreaterThan(0);
  });

  test("7. PUT with params + body both work together", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("PUT", "/users/99", {
      body: { name: "Updated", email: "updated@example.com" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      id: string;
      name: string;
      email: string;
    };
    expect(json.id).toBe("99");
    expect(json.name).toBe("Updated");
    expect(json.email).toBe("updated@example.com");
  });

  test("8. DELETE works", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("DELETE", "/users/55");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deleted: string };
    expect(json.deleted).toBe("55");
  });

  test("9. non-existent route returns 404", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("GET", "/does-not-exist");
    expect(res.status).toBe(404);
  });

  test("10. middleware executes in correct order (dir1 -> dir2 -> route1)", async () => {
    middlewareOrder = [];
    const { makeRequest } = getCtx();
    const res = await makeRequest("GET", "/ordered");
    expect(res.status).toBe(200);
    expect(middlewareOrder).toEqual(["dir1", "dir2", "route1"]);
  });

  test("11. plain returns honor buffered status and headers", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("POST", "/created");
    expect(res.status).toBe(201);
    expect(res.headers.get("x-created")).toBe("yes");
    expect(await res.json()).toEqual({ created: true });
  });

  test("12. redirects preserve the Location header", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("GET", "/redirect", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com");
  });

  test("13. raw Response preserves binary bodies and headers", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("GET", "/binary");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    expect(res.headers.get("x-binary")).toBe("yes");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0, 255, 1]);
  });

  test("14. ctx.request exposes the inbound body", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("POST", "/echo-body", {
      body: { hello: "world" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bodyText: '{"hello":"world"}' });
  });

  test("15. streamed text starts before the tail chunk is produced", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("GET", "/stream-text");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const combined = await readStreamWithEarlyFirstChunk(res, FIRST_CHUNK_TIMEOUT_MS);
    expect(new TextDecoder().decode(combined)).toBe("hello\nworld");
  });

  test("16. SSE responses stream the first event immediately", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("GET", "/stream-sse");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const combined = await readStreamWithEarlyFirstChunk(res, FIRST_CHUNK_TIMEOUT_MS);
    expect(new TextDecoder().decode(combined)).toBe("data: one\n\ndata: two\n\n");
  });

  test("17. streamed binary responses preserve bytes without buffering first", async () => {
    const { makeRequest } = getCtx();
    const res = await makeRequest("GET", "/stream-binary");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    expect(res.headers.get("x-streamed")).toBe("yes");

    const combined = await readStreamWithEarlyFirstChunk(res, FIRST_CHUNK_TIMEOUT_MS);
    expect(combined.byteLength).toBe(
      STREAM_BINARY_CHUNK_ONE_SIZE + STREAM_BINARY_CHUNK_TWO_SIZE,
    );
    expect(combined.slice(0, STREAM_BINARY_CHUNK_ONE_SIZE).every((byte) => byte === 7)).toBe(true);
    expect(combined.slice(STREAM_BINARY_CHUNK_ONE_SIZE).every((byte) => byte === 9)).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// Response validation route tree (shared)
// ---------------------------------------------------------------------------

function buildResponseValidationRouteTree(): RouteTree {
  return [
    // Handler returns wrong shape — should fail with validateResponses
    {
      path: "/bad-response",
      method: "get",
      route: createRoute({
        schemas: {
          response: z.object({ id: z.string(), name: z.string() }),
        },
        // Returns wrong shape on purpose (cast to bypass type check in test)
        handler: (async () => ({ wrong: "field" })) as never,
      }),
      middleware: [],
    },
    // Handler returns correct shape — should pass
    {
      path: "/good-response",
      method: "get",
      route: createRoute({
        schemas: {
          response: z.object({ id: z.string(), name: z.string() }),
        },
        handler: async () => ({ id: "1", name: "Kyle" }),
      }),
      middleware: [],
    },
    // No response schema — should always pass
    {
      path: "/no-schema",
      method: "get",
      route: createRoute({
        handler: async () => ({ anything: "goes" }),
      }),
      middleware: [],
    },
  ];
}

function responseValidationTests(
  adapterName: string,
  getCtx: () => { withValidation: MakeRequest; withoutValidation: MakeRequest },
) {
  test("bad response returns 500 when validateResponses is enabled", async () => {
    const { withValidation } = getCtx();
    const res = await withValidation("GET", "/bad-response");
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; data: { issues: unknown[] } };
    expect(json.error).toContain("Response validation failed");
    expect(json.data.issues.length).toBeGreaterThan(0);
  });

  test("bad response passes through when validateResponses is disabled", async () => {
    const { withoutValidation } = getCtx();
    const res = await withoutValidation("GET", "/bad-response");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { wrong: string };
    expect(json.wrong).toBe("field");
  });

  test("good response passes with validateResponses enabled", async () => {
    const { withValidation } = getCtx();
    const res = await withValidation("GET", "/good-response");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; name: string };
    expect(json.id).toBe("1");
  });

  test("no response schema — always passes", async () => {
    const { withValidation } = getCtx();
    const res = await withValidation("GET", "/no-schema");
    expect(res.status).toBe(200);
  });
}

// ---------------------------------------------------------------------------
// Hono
// ---------------------------------------------------------------------------

describe("Hono adapter", () => {
  const ctx = { makeRequest: null! as MakeRequest };

  beforeAll(() => {
    const hono = setupHono();
    ctx.makeRequest = hono.makeRequest;
  });

  adapterTests("Hono", () => ctx);

  describe("response validation", () => {
    const rvCtx = { withValidation: null! as MakeRequest, withoutValidation: null! as MakeRequest };

    beforeAll(() => {
      const validated = createHonoApp(buildResponseValidationRouteTree(), { validateResponses: true });
      const unvalidated = createHonoApp(buildResponseValidationRouteTree());
      rvCtx.withValidation = async (method, path, options) => {
        const req = jsonReq("http://localhost", method, path, options);
        return validated.fetch(req);
      };
      rvCtx.withoutValidation = async (method, path, options) => {
        const req = jsonReq("http://localhost", method, path, options);
        return unvalidated.fetch(req);
      };
    });

    responseValidationTests("Hono", () => rvCtx);
  });
});

// ---------------------------------------------------------------------------
// Koa
// ---------------------------------------------------------------------------

describe("Koa adapter", () => {
  const ctx = { makeRequest: null! as MakeRequest };
  let teardown: () => void;

  beforeAll(async () => {
    const koa = setupKoa();
    await koa.start();
    ctx.makeRequest = koa.makeRequest;
    teardown = koa.teardown;
  });

  afterAll(() => {
    teardown?.();
  });

  adapterTests("Koa", () => ctx);

  describe("response validation", () => {
    const rvCtx = { withValidation: null! as MakeRequest, withoutValidation: null! as MakeRequest };
    let rvTeardown: (() => void)[] = [];

    beforeAll(async () => {
      const validated = createKoaApp(buildResponseValidationRouteTree(), { validateResponses: true });
      const unvalidated = createKoaApp(buildResponseValidationRouteTree());

      const [vPort, uPort] = await Promise.all([
        new Promise<number>((resolve) => {
          const s = validated.listen(0, () => { rvTeardown.push(() => s.close()); resolve((s.address() as { port: number }).port); });
        }),
        new Promise<number>((resolve) => {
          const s = unvalidated.listen(0, () => { rvTeardown.push(() => s.close()); resolve((s.address() as { port: number }).port); });
        }),
      ]);

      rvCtx.withValidation = async (method, path, options) => fetch(jsonReq(`http://127.0.0.1:${vPort}`, method, path, options));
      rvCtx.withoutValidation = async (method, path, options) => fetch(jsonReq(`http://127.0.0.1:${uPort}`, method, path, options));
    });

    afterAll(() => rvTeardown.forEach((fn) => fn()));

    responseValidationTests("Koa", () => rvCtx);
  });
});

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

describe("Express adapter", () => {
  const ctx = { makeRequest: null! as MakeRequest };
  let teardown: () => void;

  beforeAll(async () => {
    const exp = setupExpress();
    await exp.start();
    ctx.makeRequest = exp.makeRequest;
    teardown = exp.teardown;
  });

  afterAll(() => {
    teardown?.();
  });

  adapterTests("Express", () => ctx);

  describe("response validation", () => {
    const rvCtx = { withValidation: null! as MakeRequest, withoutValidation: null! as MakeRequest };
    let rvTeardown: (() => void)[] = [];

    beforeAll(async () => {
      const validated = createExpressApp(buildResponseValidationRouteTree(), { validateResponses: true });
      const unvalidated = createExpressApp(buildResponseValidationRouteTree());

      const [vPort, uPort] = await Promise.all([
        new Promise<number>((resolve) => {
          const s = validated.listen(0, () => { rvTeardown.push(() => s.close()); resolve((s.address() as { port: number }).port); });
        }),
        new Promise<number>((resolve) => {
          const s = unvalidated.listen(0, () => { rvTeardown.push(() => s.close()); resolve((s.address() as { port: number }).port); });
        }),
      ]);

      rvCtx.withValidation = async (method, path, options) => fetch(jsonReq(`http://127.0.0.1:${vPort}`, method, path, options));
      rvCtx.withoutValidation = async (method, path, options) => fetch(jsonReq(`http://127.0.0.1:${uPort}`, method, path, options));
    });

    afterAll(() => rvTeardown.forEach((fn) => fn()));

    responseValidationTests("Express", () => rvCtx);
  });
});

// ---------------------------------------------------------------------------
// Elysia
// ---------------------------------------------------------------------------

describe("Elysia adapter", () => {
  const ctx = { makeRequest: null! as MakeRequest };

  beforeAll(() => {
    const elysia = setupElysia();
    ctx.makeRequest = elysia.makeRequest;
  });

  adapterTests("Elysia", () => ctx);

  describe("response validation", () => {
    const rvCtx = { withValidation: null! as MakeRequest, withoutValidation: null! as MakeRequest };

    beforeAll(() => {
      const validated = createElysiaApp(buildResponseValidationRouteTree(), { validateResponses: true });
      const unvalidated = createElysiaApp(buildResponseValidationRouteTree());
      rvCtx.withValidation = async (method, path, options) => validated.handle(jsonReq("http://localhost", method, path, options));
      rvCtx.withoutValidation = async (method, path, options) => unvalidated.handle(jsonReq("http://localhost", method, path, options));
    });

    responseValidationTests("Elysia", () => rvCtx);
  });
});
