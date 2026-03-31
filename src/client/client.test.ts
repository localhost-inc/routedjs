import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { createRoute } from "../core/create-route.ts";
import { createMiddleware } from "../core/create-middleware.ts";
import { defineRouteTree } from "../core/define-route-tree.ts";
import { createHonoApp } from "../adapters/hono.ts";
import { createClient, ClientError, type RouteMap, type Client } from "./index.ts";

// ---------------------------------------------------------------------------
// Test route tree
// ---------------------------------------------------------------------------

const routeTree = defineRouteTree([
  {
    path: "/health",
    method: "get",
    route: createRoute({
      handler: async () => ({ status: "ok" }),
    }),
    middleware: [],
  },
  {
    path: "/users",
    method: "get",
    route: createRoute({
      schemas: {
        query: z.object({ limit: z.coerce.number().optional() }),
        response: z.object({
          users: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
      },
      handler: async ({ query }) => ({
        users: [{ id: "1", name: "Kyle" }],
      }),
    }),
    middleware: [],
  },
  {
    path: "/users",
    method: "post",
    route: createRoute({
      schemas: {
        body: z.object({ name: z.string(), email: z.string().email() }),
        response: z.object({ id: z.string(), name: z.string(), email: z.string() }),
      },
      handler: async ({ body }) => ({
        id: "new-1",
        name: body.name,
        email: body.email,
      }),
    }),
    middleware: [],
  },
  {
    path: "/users/:userId",
    method: "get",
    route: createRoute({
      schemas: {
        params: z.object({ userId: z.string() }),
        response: z.object({ id: z.string(), name: z.string() }),
      },
      handler: async ({ params }) => ({ id: params.userId, name: "Kyle" }),
    }),
    middleware: [],
  },
  {
    path: "/users/:userId",
    method: "put",
    route: createRoute({
      schemas: {
        params: z.object({ userId: z.string() }),
        body: z.object({ name: z.string() }),
        response: z.object({ id: z.string(), name: z.string() }),
      },
      handler: async ({ params, body }) => ({
        id: params.userId,
        name: body.name,
      }),
    }),
    middleware: [],
  },
  {
    path: "/users/:userId",
    method: "delete",
    route: createRoute({
      schemas: {
        params: z.object({ userId: z.string() }),
      },
      handler: async ({ params }) => ({ deleted: params.userId }),
    }),
    middleware: [],
  },
  {
    path: "/error",
    method: "get",
    route: createRoute({
      handler: async ({ ctx }) => ctx.json({ error: "Not found" }, 404),
    }),
    middleware: [],
  },
]);

// ---------------------------------------------------------------------------
// Define a RouteMap type for testing
// ---------------------------------------------------------------------------

type TestRouteMap = {
  "get /health": { params: undefined; query: undefined; body: undefined; response: { status: string } };
  "get /users": { params: undefined; query: { limit?: number }; body: undefined; response: { users: { id: string; name: string }[] } };
  "post /users": { params: undefined; query: undefined; body: { name: string; email: string }; response: { id: string; name: string; email: string } };
  "get /users/:userId": { params: { userId: string }; query: undefined; body: undefined; response: { id: string; name: string } };
  "put /users/:userId": { params: { userId: string }; query: undefined; body: { name: string }; response: { id: string; name: string } };
  "delete /users/:userId": { params: { userId: string }; query: undefined; body: undefined; response: { deleted: string } };
  "get /error": { params: undefined; query: undefined; body: undefined; response: unknown };
};

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let client: Client<TestRouteMap>;

beforeAll(() => {
  const app = createHonoApp(routeTree);
  server = Bun.serve({ fetch: app.fetch, port: 0 });
  client = createClient<TestRouteMap>({
    baseUrl: `http://localhost:${server.port}`,
  });
});

afterAll(() => {
  server?.stop();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createClient", () => {
  test("GET static route (no params)", async () => {
    const res = await client.health.get();
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ status: "ok" });
  });

  test("GET with query params", async () => {
    const res = await client.users.get({ query: { limit: 10 } });
    expect(res.status).toBe(200);
    expect(res.data.users).toHaveLength(1);
  });

  test("POST with body", async () => {
    const res = await client.users.post({
      body: { name: "Bob", email: "bob@example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.data.name).toBe("Bob");
    expect(res.data.email).toBe("bob@example.com");
    expect(res.data.id).toBe("new-1");
  });

  test("GET with path params", async () => {
    const res = await client.users[":userId"].get({
      params: { userId: "abc-123" },
    });
    expect(res.status).toBe(200);
    expect(res.data.id).toBe("abc-123");
    expect(res.data.name).toBe("Kyle");
  });

  test("PUT with path params and body", async () => {
    const res = await client.users[":userId"].put({
      params: { userId: "42" },
      body: { name: "Updated" },
    });
    expect(res.status).toBe(200);
    expect(res.data.id).toBe("42");
    expect(res.data.name).toBe("Updated");
  });

  test("DELETE with path params", async () => {
    const res = await client.users[":userId"].delete({
      params: { userId: "99" },
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ deleted: "99" });
  });

  test("non-2xx response throws ClientError", async () => {
    try {
      await client.error.get();
      expect(true).toBe(false); // Should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(ClientError);
      const clientErr = err as ClientError;
      expect(clientErr.status).toBe(404);
      expect(clientErr.data).toEqual({ error: "Not found" });
    }
  });

  test("custom headers are sent", async () => {
    // Just verify it doesn't break — the server doesn't check headers
    const res = await client.health.get({
      headers: { "x-custom": "value" },
    });
    expect(res.status).toBe(200);
  });

  test("base headers via function", async () => {
    const customClient = createClient<TestRouteMap>({
      baseUrl: `http://localhost:${server.port}`,
      headers: () => ({ "x-token": "abc" }),
    });
    const res = await customClient.health.get();
    expect(res.status).toBe(200);
  });
});
