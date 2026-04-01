import { createRequire } from "node:module";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { extractParamNames, extractSplatParamNames, toOpenAPIPath } from "../core/path.ts";
import { getResponseSchemas } from "../core/responses.ts";
import type { RouteEntry, RouteTree } from "../core/types.ts";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type OpenAPIInfo = {
  title: string;
  version: string;
  description?: string;
};

type OpenAPIServer = {
  url: string;
  description?: string;
};

type OpenAPIConfig = {
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
};

type OpenAPISpec = {
  openapi: string;
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  paths: Record<string, Record<string, unknown>>;
};

export function generateOpenAPISpec(
  routeTree: RouteTree,
  config: OpenAPIConfig,
): OpenAPISpec {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const entry of routeTree) {
    const openApiPath = toOpenAPIPath(entry.path);

    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }

    paths[openApiPath]![entry.method] = buildOperation(entry);
  }

  return {
    openapi: "3.1.0",
    info: config.info,
    ...(config.servers ? { servers: config.servers } : {}),
    paths,
  };
}

// ---------------------------------------------------------------------------
// Operation builder
// ---------------------------------------------------------------------------

function buildOperation(entry: RouteEntry): Record<string, unknown> {
  const { route, path, method } = entry;
  const { schemas, meta } = route;
  const operation: Record<string, unknown> = {};

  // Meta
  operation.operationId = meta?.operationId ?? deriveOperationId(path, method);
  if (meta?.summary) operation.summary = meta.summary;
  if (meta?.description) operation.description = meta.description;
  if (meta?.tags?.length) operation.tags = meta.tags;
  if (meta?.deprecated) operation.deprecated = true;

  // Parameters (path + query)
  const parameters: unknown[] = [];

  if (schemas.params) {
    parameters.push(...extractPathParams(schemas.params, path));
  }

  if (schemas.query) {
    parameters.push(...extractQueryParams(schemas.query));
  }

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  // Request body
  if (schemas.body) {
    const bodySchema = schemaToJsonSchema(schemas.body);
    if (bodySchema) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: bodySchema,
          },
        },
      };
    }
  }

  // Responses
  const responseSchemas = getResponseSchemas(schemas);

  if (responseSchemas.size > 0) {
    operation.responses = Object.fromEntries(
      Array.from(responseSchemas.entries())
        .sort(([leftStatus], [rightStatus]) => leftStatus - rightStatus)
        .map(([status, schema]) => {
          const responseSchema = schemaToJsonSchema(schema);

          return [
            String(status),
            {
              description: getResponseDescription(status, meta?.summary),
              ...(responseSchema
                ? {
                    content: {
                      "application/json": {
                        schema: responseSchema,
                      },
                    },
                  }
                : {}),
            },
          ];
        }),
    );
  } else {
    operation.responses = {
      "200": {
        description: meta?.summary ?? "Successful response",
      },
    };
  }

  return operation;
}

// ---------------------------------------------------------------------------
// Parameter extraction
// ---------------------------------------------------------------------------

function extractPathParams(
  paramsSchema: StandardSchemaV1,
  path: string,
): unknown[] {
  const jsonSchema = schemaToJsonSchema(paramsSchema);
  if (!jsonSchema) return [];

  const properties = (jsonSchema as Record<string, unknown>).properties as
    | Record<string, unknown>
    | undefined;

  if (!properties) return [];

  // Only include params that are actually in the path
  const pathParamNames = extractParamNames(path);
  const splatParamNames = new Set(extractSplatParamNames(path));

  return Object.entries(properties)
    .filter(([name]) => pathParamNames.includes(name))
    .map(([name, schema]) => ({
      name,
      in: "path",
      required: true, // path params are always required
      schema: splatParamNames.has(name) ? toOpenAPIPathParamSchema(schema) : schema,
    }));
}

function toOpenAPIPathParamSchema(schema: unknown): Record<string, unknown> {
  const baseSchema =
    schema && typeof schema === "object"
      ? { ...(schema as Record<string, unknown>) }
      : {};
  const existingDescription = typeof baseSchema.description === "string"
    ? baseSchema.description
    : undefined;
  const description =
    "Slash-delimited catch-all path remainder. Encode each segment separately when constructing the URL.";

  return {
    type: "string",
    ...(existingDescription
      ? { description: `${existingDescription} ${description}` }
      : { description }),
  };
}

function extractQueryParams(querySchema: StandardSchemaV1): unknown[] {
  const jsonSchema = schemaToJsonSchema(querySchema);
  if (!jsonSchema) return [];

  const properties = (jsonSchema as Record<string, unknown>).properties as
    | Record<string, unknown>
    | undefined;

  if (!properties) return [];

  const required = ((jsonSchema as Record<string, unknown>).required as string[]) ?? [];

  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: "query",
    required: required.includes(name),
    schema,
  }));
}

// ---------------------------------------------------------------------------
// Schema conversion — Standard JSON Schema with zod-to-json-schema fallback
// ---------------------------------------------------------------------------

function schemaToJsonSchema(schema: StandardSchemaV1): unknown | null {
  const std = schema["~standard"] as unknown as Record<string, unknown>;

  // 1. Try StandardJSONSchemaV1 (library-native JSON Schema conversion)
  if (
    "jsonSchema" in std &&
    std.jsonSchema &&
    typeof std.jsonSchema === "object" &&
    "output" in (std.jsonSchema as object) &&
    typeof (std.jsonSchema as Record<string, unknown>).output === "function"
  ) {
    try {
      return (std.jsonSchema as { output: (opts: { target: string }) => unknown }).output({
        target: "openapi-3.0",
      });
    } catch {
      // Fall through to next strategy
    }
  }

  // 2. Fallback: zod-to-json-schema for Zod schemas
  if (std.vendor === "zod") {
    try {
      const { zodToJsonSchema } = require("zod-to-json-schema") as {
        zodToJsonSchema: (schema: unknown, opts: unknown) => Record<string, unknown>;
      };
      const jsonSchema = zodToJsonSchema(schema, { target: "openApi3" });
      const { $schema, ...rest } = jsonSchema;
      return rest;
    } catch {
      // zod-to-json-schema not installed — skip
    }
  }

  // 3. No conversion available
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveOperationId(path: string, method: string): string {
  // GET /users/:userId/visits → getUsersByUserIdVisits
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) {
        return "By" + capitalize(segment.replace(/^:/, "").replace(/\*$/, ""));
      }
      return capitalize(segment);
    });

  return method + segments.join("");
}

function getResponseDescription(status: number, summary?: string): string {
  if (status >= 200 && status < 300) {
    return summary ?? "Successful response";
  }

  return `Response ${status}`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
