import { describe, expect, test } from "bun:test";
import { createRoute } from "./create-route.ts";
import { createMiddleware } from "./create-middleware.ts";
import { defineRouteTree } from "./define-route-tree.ts";
import { BaseRouteContext } from "./context.ts";
import { RouteError } from "./error.ts";
import { z } from "zod";
import type { RouteContext } from "./context.ts";
import type { RouteTree } from "./types.ts";

/** Minimal RouteContext for testing. */
class TestRouteContext extends BaseRouteContext {
  readonly request: Request;
  readonly method: string;
  readonly path: string;
  readonly raw: unknown;
  constructor(url = "http://localhost/test", method = "GET") {
    super();
    this.request = new Request(url, { method });
    this.method = method;
    this.path = new URL(url).pathname;
    this.raw = null;
  }
}

// ---------------------------------------------------------------------------
// createRoute
// ---------------------------------------------------------------------------

describe("createRoute", () => {
  test("returns correct shape with __brand, schemas, middleware, handler", () => {
    const schemas = {
      params: z.object({ id: z.string() }),
      body: z.object({ name: z.string() }),
      response: z.object({ ok: z.boolean() }),
    };

    const handler = () => ({ ok: true });

    const route = createRoute({ schemas, handler });

    expect(route.__brand).toBe("routed:route");
    expect(route.schemas).toBe(schemas);
    expect(route.middleware).toEqual([]);
    expect(route.handler).toBe(handler);
    expect(route.meta).toBeUndefined();
  });

  test("with no schemas defaults to empty object", () => {
    const handler = () => {};
    const route = createRoute({ handler });

    expect(route.schemas).toEqual({});
  });

  test("with no middleware defaults to empty array", () => {
    const handler = () => {};
    const route = createRoute({ handler });

    expect(route.middleware).toEqual([]);
    expect(Array.isArray(route.middleware)).toBe(true);
    expect(route.middleware).toHaveLength(0);
  });

  test("with middleware passes them through", () => {
    const mw1 = createMiddleware(async ({ next }) => {
      await next();
    });
    const mw2 = createMiddleware(async ({ next }) => {
      await next();
    });

    const route = createRoute({
      middleware: [mw1, mw2],
      handler: () => {},
    });

    expect(route.middleware).toHaveLength(2);
    expect(route.middleware[0]).toBe(mw1);
    expect(route.middleware[1]).toBe(mw2);
  });

  test("with meta passes it through", () => {
    const meta = {
      summary: "Get user by ID",
      description: "Returns a user object",
      tags: ["users"],
      operationId: "getUserById",
      deprecated: false,
    };

    const route = createRoute({ meta, handler: () => {} });

    expect(route.meta).toBe(meta);
    expect(route.meta!.summary).toBe("Get user by ID");
    expect(route.meta!.tags).toEqual(["users"]);
    expect(route.meta!.operationId).toBe("getUserById");
    expect(route.meta!.deprecated).toBe(false);
  });

  test("with partial meta passes it through", () => {
    const route = createRoute({
      meta: { summary: "Test" },
      handler: () => {},
    });

    expect(route.meta).toEqual({ summary: "Test" });
  });
});

// ---------------------------------------------------------------------------
// createMiddleware
// ---------------------------------------------------------------------------

describe("createMiddleware", () => {
  test("returns correct shape with __brand and handler", () => {
    const handler = async ({ next }: { ctx: RouteContext; next: () => Promise<unknown> }) => {
      await next();
    };

    const mw = createMiddleware(handler);

    expect(mw.__brand).toBe("routed:middleware");
    expect(typeof mw.handler).toBe("function");
  });

  test("handler is callable", async () => {
    let called = false;
    const mw = createMiddleware(async ({ next }) => {
      called = true;
      await next();
    });

    await mw.handler({ ctx: new TestRouteContext(), next: async () => {} });
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RouteContext
// ---------------------------------------------------------------------------

describe("RouteContext", () => {
  test("header() reads request headers", () => {
    const req = new Request("http://localhost/test", {
      headers: { authorization: "Bearer abc" },
    });
    const ctx = new (class extends BaseRouteContext {
      request = req;
      method = "GET";
      path = "/test";
      raw = null;
    })();

    expect(ctx.header("authorization")).toBe("Bearer abc");
    expect(ctx.header("x-missing")).toBeUndefined();
  });

  test("json() returns a JSON Response", async () => {
    const ctx = new TestRouteContext();
    const res = ctx.json({ ok: true }, 201);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("text() returns a text Response", async () => {
    const ctx = new TestRouteContext();
    const res = ctx.text("hello", 200);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  test("redirect() returns a redirect Response", () => {
    const ctx = new TestRouteContext();
    const res = ctx.redirect("https://example.com", 301);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://example.com");
  });

  test("status() sets default status for json/text", async () => {
    const ctx = new TestRouteContext();
    ctx.status(404);
    const res = ctx.json({ error: "not found" });
    expect(res.status).toBe(404);
  });

  test("setHeader() adds headers to json/text responses", async () => {
    const ctx = new TestRouteContext();
    ctx.setHeader("x-custom", "value");
    const res = ctx.json({ ok: true });
    expect(res.headers.get("x-custom")).toBe("value");
  });
});

// ---------------------------------------------------------------------------
// Context state — set/get
// ---------------------------------------------------------------------------

describe("context state", () => {
  test("set/get round-trips", () => {
    const ctx = new TestRouteContext();
    ctx.set("user", { id: "1", name: "Kyle" });
    const user = ctx.get("user") as { id: string; name: string };

    expect(user.id).toBe("1");
    expect(user.name).toBe("Kyle");
  });

  test("get() throws on unset key", () => {
    const ctx = new TestRouteContext();
    expect(() => ctx.get("missing")).toThrow('Context key "missing" has not been set');
  });

  test("separate keys don't collide", () => {
    const ctx = new TestRouteContext();
    ctx.set("a", "hello");
    ctx.set("b", 42);

    expect(ctx.get("a")).toBe("hello");
    expect(ctx.get("b")).toBe(42);
  });

  test("middleware state flows to handler via createMiddleware<TState>", () => {
    type User = { id: string; name: string };
    const auth = createMiddleware<{ user: User }>(async ({ ctx, next }) => {
      ctx.set("user", { id: "1", name: "Kyle" });
      await next();
    });

    // Verify the middleware handler works at runtime
    const ctx = new TestRouteContext();
    let handlerRan = false;
    auth.handler({
      ctx,
      next: async () => {
        handlerRan = true;
      },
    });

    expect(ctx.get("user")).toEqual({ id: "1", name: "Kyle" });
  });
});

// ---------------------------------------------------------------------------
// RouteError
// ---------------------------------------------------------------------------

describe("RouteError", () => {
  test("has status and message", () => {
    const err = new RouteError(404, "Not found");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
    expect(err.data).toBeUndefined();
    expect(err).toBeInstanceOf(Error);
  });

  test("supports optional data", () => {
    const err = new RouteError(422, "Validation failed", { field: "email" });
    expect(err.status).toBe(422);
    expect(err.data).toEqual({ field: "email" });
  });
});

// ---------------------------------------------------------------------------
// defineRouteTree
// ---------------------------------------------------------------------------

describe("defineRouteTree", () => {
  test("is identity function - returns what you give it", () => {
    const tree: RouteTree = [
      {
        path: "/users",
        method: "get",
        route: createRoute({ handler: () => {} }),
        middleware: [],
      },
      {
        path: "/users",
        method: "post",
        route: createRoute({
          schemas: { body: z.object({ name: z.string() }) },
          handler: () => {},
        }),
        middleware: [],
      },
    ];

    const result = defineRouteTree(tree);

    expect(result).toBe(tree);
    expect(result).toHaveLength(2);
    expect(result[0]!.path).toBe("/users");
    expect(result[1]!.method).toBe("post");
  });

  test("returns empty array unchanged", () => {
    const tree: RouteTree = [];
    const result = defineRouteTree(tree);
    expect(result).toBe(tree);
    expect(result).toHaveLength(0);
  });
});
