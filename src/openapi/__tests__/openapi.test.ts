import { describe, expect, test } from "bun:test";
import path from "node:path";
import { z } from "zod";
import { createRoute } from "../../core/create-route.ts";
import { createMiddleware } from "../../core/create-middleware.ts";
import { defineRouteTree } from "../../core/define-route-tree.ts";
import { generateOpenAPISpec } from "../index.ts";

const noop = createMiddleware(async ({ next }) => next());

const routeTree = defineRouteTree([
  {
    path: "/health",
    method: "get",
    route: createRoute({
      meta: { summary: "Health check", tags: ["ops"] },
      handler: async () => ({ status: "ok" }),
    }),
    middleware: [],
  },
  {
    path: "/users",
    method: "get",
    route: createRoute({
      meta: { summary: "List users", tags: ["users"] },
      schemas: {
        query: z.object({
          limit: z.number().optional(),
          offset: z.number().optional(),
        }),
        response: z.object({
          users: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
      },
      handler: async () => ({ users: [] }),
    }),
    middleware: [noop],
  },
  {
    path: "/users",
    method: "post",
    route: createRoute({
      meta: { summary: "Create user", tags: ["users"] },
      schemas: {
        body: z.object({
          name: z.string(),
          email: z.string().email(),
        }),
        response: z.object({ id: z.string(), name: z.string() }),
      },
      handler: async ({ body }) => ({ id: "1", ...body }),
    }),
    middleware: [noop],
  },
  {
    path: "/users/:userId",
    method: "get",
    route: createRoute({
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
    }),
    middleware: [],
  },
  {
    path: "/legacy/endpoint",
    method: "get",
    route: createRoute({
      meta: { deprecated: true, summary: "Old endpoint" },
      handler: async () => ({ ok: true }),
    }),
    middleware: [],
  },
  {
    path: "/storage/:path*",
    method: "get",
    route: createRoute({
      meta: { summary: "Get file by path" },
      schemas: {
        params: z.object({ path: z.array(z.string()) }),
      },
      handler: async ({ params }) => ({ path: params.path }),
    }),
    middleware: [],
  },
]);

const spec = generateOpenAPISpec(routeTree, {
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "http://localhost:3000" }],
});

describe("generateOpenAPISpec", () => {
  test("produces valid OpenAPI 3.1 structure", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Test API");
    expect(spec.info.version).toBe("1.0.0");
    expect(spec.servers).toHaveLength(1);
  });

  test("generates paths with correct methods", () => {
    expect(spec.paths["/health"]).toBeDefined();
    expect(spec.paths["/health"]!.get).toBeDefined();

    expect(spec.paths["/users"]).toBeDefined();
    expect(spec.paths["/users"]!.get).toBeDefined();
    expect(spec.paths["/users"]!.post).toBeDefined();

    expect(spec.paths["/users/{userId}"]).toBeDefined();
    expect(spec.paths["/users/{userId}"]!.get).toBeDefined();
    expect(spec.paths["/storage/{path}"]).toBeDefined();
    expect(spec.paths["/storage/{path}"]!.get).toBeDefined();
  });

  test("converts :param to {param} in paths", () => {
    expect(spec.paths["/users/:userId"]).toBeUndefined();
    expect(spec.paths["/users/{userId}"]).toBeDefined();
    expect(spec.paths["/storage/:path*"]).toBeUndefined();
    expect(spec.paths["/storage/{path}"]).toBeDefined();
  });

  test("includes meta fields", () => {
    const getHealth = spec.paths["/health"]!.get as Record<string, unknown>;
    expect(getHealth.summary).toBe("Health check");
    expect(getHealth.tags).toEqual(["ops"]);
  });

  test("uses custom operationId when provided", () => {
    const getUser = spec.paths["/users/{userId}"]!.get as Record<string, unknown>;
    expect(getUser.operationId).toBe("getUser");
  });

  test("auto-derives operationId when not provided", () => {
    const getHealth = spec.paths["/health"]!.get as Record<string, unknown>;
    expect(getHealth.operationId).toBe("getHealth");

    const postUsers = spec.paths["/users"]!.post as Record<string, unknown>;
    expect(postUsers.operationId).toBe("postUsers");

    const getStorage = spec.paths["/storage/{path}"]!.get as Record<string, unknown>;
    expect(getStorage.operationId).toBe("getStorageByPath");
  });

  test("generates path parameters from params schema", () => {
    const getUser = spec.paths["/users/{userId}"]!.get as Record<string, unknown>;
    const params = getUser.parameters as Array<Record<string, unknown>>;
    expect(params).toHaveLength(1);
    expect(params[0]!.name).toBe("userId");
    expect(params[0]!.in).toBe("path");
    expect(params[0]!.required).toBe(true);

    const getStorage = spec.paths["/storage/{path}"]!.get as Record<string, unknown>;
    const storageParams = getStorage.parameters as Array<Record<string, unknown>>;
    expect(storageParams).toHaveLength(1);
    expect(storageParams[0]!.name).toBe("path");
    expect(storageParams[0]!.in).toBe("path");
    expect(storageParams[0]!.schema).toEqual({
      type: "string",
      description:
        "Slash-delimited catch-all path remainder. Encode each segment separately when constructing the URL.",
    });
  });

  test("generates query parameters from query schema", () => {
    const getUsers = spec.paths["/users"]!.get as Record<string, unknown>;
    const params = getUsers.parameters as Array<Record<string, unknown>>;
    expect(params).toHaveLength(2);
    expect(params.map((p) => p.name)).toContain("limit");
    expect(params.map((p) => p.name)).toContain("offset");
    // Optional query params
    expect(params.find((p) => p.name === "limit")!.required).toBe(false);
  });

  test("generates requestBody from body schema", () => {
    const postUsers = spec.paths["/users"]!.post as Record<string, unknown>;
    const body = postUsers.requestBody as Record<string, unknown>;
    expect(body.required).toBe(true);
    const content = body.content as Record<string, unknown>;
    const json = content["application/json"] as Record<string, unknown>;
    const schema = json.schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
  });

  test("generates status-aware response schemas", () => {
    const getUser = spec.paths["/users/{userId}"]!.get as Record<string, unknown>;
    const responses = getUser.responses as Record<string, Record<string, unknown>>;
    const ok = responses["200"]!;
    expect(ok.description).toBe("Get user by ID");
    const content = ok.content as Record<string, unknown>;
    expect(content["application/json"]).toBeDefined();
    expect(responses["404"]?.description).toBe("Response 404");
  });

  test("marks deprecated routes", () => {
    const legacy = spec.paths["/legacy/endpoint"]!.get as Record<string, unknown>;
    expect(legacy.deprecated).toBe(true);
  });

  test("built Node ESM output preserves Zod schemas", async () => {
    const repoRoot = path.resolve(import.meta.dir, "../../..");

    const build = Bun.spawn([process.execPath, "run", "build"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const buildExitCode = await build.exited;
    const buildStderr = await new Response(build.stderr).text();
    expect(buildExitCode, buildStderr).toBe(0);

    const nodeScript = `
      import { generateOpenAPISpec } from "./dist/openapi/index.js";
      import { z } from "zod";

      const spec = generateOpenAPISpec([
        {
          path: "/users/:userId",
          method: "get",
          route: {
            schemas: {
              params: z.object({ userId: z.string().uuid() }),
              responses: {
                200: z.object({ id: z.string() }),
                404: z.object({ error: z.string() }),
              },
            },
            middleware: [],
            handler: () => ({ id: "1" }),
          },
          middleware: [],
        },
      ], {
        info: { title: "Test API", version: "1.0.0" },
      });

      console.log(JSON.stringify(spec));
    `;

    const run = Bun.spawn(["node", "--input-type=module", "-e", nodeScript], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const runExitCode = await run.exited;
    const runStderr = await new Response(run.stderr).text();
    expect(runExitCode, runStderr).toBe(0);

    const output = await new Response(run.stdout).text();
    const builtSpec = JSON.parse(output) as {
      paths: Record<string, Record<string, { parameters?: Array<{ schema?: Record<string, unknown> }>; responses: Record<string, { content?: Record<string, unknown> }> }>>;
    };

    const getUser = builtSpec.paths["/users/{userId}"]!.get!;
    expect(getUser.parameters?.[0]?.schema?.type).toBe("string");
    expect(getUser.parameters?.[0]?.schema?.format).toBe("uuid");
    expect(getUser.responses["200"]?.content?.["application/json"]).toBeDefined();
    expect(getUser.responses["404"]?.content?.["application/json"]).toBeDefined();
  });
});
