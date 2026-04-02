import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { validateSchema } from "../validate.ts";
import { createRoute } from "../create-route.ts";
import { defineRouteTree } from "../define-route-tree.ts";
import { createHonoApp } from "../../frameworks/hono.ts";

// ---------------------------------------------------------------------------
// Custom schema that implements StandardSchemaV1 (no Zod)
// ---------------------------------------------------------------------------

function customString(): StandardSchemaV1<unknown, string> {
  return {
    "~standard": {
      version: 1,
      vendor: "custom",
      validate(value) {
        if (typeof value === "string") {
          return { value };
        }
        return { issues: [{ message: "Expected string" }] };
      },
    },
  };
}

function customObject<T extends Record<string, StandardSchemaV1>>(
  shape: T,
): StandardSchemaV1<
  unknown,
  { [K in keyof T]: StandardSchemaV1.InferOutput<T[K]> }
> {
  return {
    "~standard": {
      version: 1,
      vendor: "custom",
      validate(value) {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "Expected object" }] };
        }
        const result: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(shape)) {
          const fieldValue = (value as Record<string, unknown>)[key];
          const fieldResult = schema["~standard"].validate(fieldValue);
          if ("issues" in fieldResult && fieldResult.issues) {
            return {
              issues: fieldResult.issues.map((issue) => ({
                ...issue,
                path: [key, ...(issue.path ?? [])],
              })),
            };
          }
          result[key] = (fieldResult as { value: unknown }).value;
        }
        return { value: result as any };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// validateSchema with custom schemas
// ---------------------------------------------------------------------------

describe("validateSchema", () => {
  test("validates with a custom StandardSchema (not Zod)", async () => {
    const schema = customString();
    const success = await validateSchema(schema, "hello");
    expect(success).toEqual({ success: true, data: "hello" });

    const failure = await validateSchema(schema, 123);
    expect(failure.success).toBe(false);
    if (!failure.success) {
      expect(failure.issues[0]!.message).toBe("Expected string");
    }
  });

  test("validates objects with a custom StandardSchema", async () => {
    const schema = customObject({
      name: customString(),
      id: customString(),
    });

    const success = await validateSchema(schema, { name: "Kyle", id: "1" });
    expect(success).toEqual({ success: true, data: { name: "Kyle", id: "1" } });

    const failure = await validateSchema(schema, { name: "Kyle", id: 42 });
    expect(failure.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Full adapter integration with custom schemas (not Zod)
// ---------------------------------------------------------------------------

describe("adapter with custom StandardSchema (no Zod)", () => {
  test("Hono adapter validates and handles with custom schemas", async () => {
    const routeTree = defineRouteTree([
      {
        path: "/greet/:name",
        method: "get",
        route: createRoute({
          schemas: {
            params: customObject({ name: customString() }),
          },
          handler: async ({ params }) => ({
            greeting: `Hello, ${(params as { name: string }).name}!`,
          }),
        }),
        middleware: [],
      },
    ]);

    const app = createHonoApp(routeTree);
    const res = await app.fetch(new Request("http://localhost/greet/World"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { greeting: string };
    expect(json.greeting).toBe("Hello, World!");
  });
});
