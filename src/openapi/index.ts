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

type OpenAPISpecVersion = "3.0.3" | "3.1.0";
type JSONSchemaTarget = "draft-2020-12" | "openapi-3.0";

type OpenAPIConfig = {
  info: OpenAPIInfo;
  specVersion?: OpenAPISpecVersion;
  servers?: OpenAPIServer[];
};

type OpenAPISpec = {
  openapi: string;
  info: OpenAPIInfo;
  jsonSchemaDialect?: string;
  servers?: OpenAPIServer[];
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas: Record<string, unknown> };
};

export function generateOpenAPISpec(
  routeTree: RouteTree,
  config: OpenAPIConfig,
): OpenAPISpec {
  const specVersion = config.specVersion ?? "3.1.0";
  const schemaTarget = getSchemaTarget(specVersion);
  const paths: Record<string, Record<string, unknown>> = {};
  const componentSchemas: Record<string, unknown> = {};

  for (const entry of routeTree) {
    const openApiPath = toOpenAPIPath(entry.path);

    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }

    paths[openApiPath]![entry.method] = buildOperation(entry, componentSchemas, schemaTarget);
  }

  const spec: OpenAPISpec = {
    openapi: specVersion,
    info: config.info,
    ...(specVersion === "3.1.0"
      ? { jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema" }
      : {}),
    ...(config.servers ? { servers: config.servers } : {}),
    paths,
  };

  if (Object.keys(componentSchemas).length > 0) {
    spec.components = { schemas: componentSchemas };
  }

  return spec;
}

// ---------------------------------------------------------------------------
// Operation builder
// ---------------------------------------------------------------------------

function buildOperation(
  entry: RouteEntry,
  componentSchemas: Record<string, unknown>,
  schemaTarget: JSONSchemaTarget,
): Record<string, unknown> {
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
    parameters.push(...extractPathParams(schemas.params, path, componentSchemas, schemaTarget));
  } else {
    parameters.push(...inferPathParams(path));
  }

  if (schemas.query) {
    parameters.push(...extractQueryParams(schemas.query, componentSchemas, schemaTarget));
  }

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  // Request body
  if (schemas.body) {
    const bodySchema = schemaToJsonSchema(schemas.body, componentSchemas, schemaTarget);
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
          const responseSchema = schemaToJsonSchema(schema, componentSchemas, schemaTarget);

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
  componentSchemas: Record<string, unknown>,
  schemaTarget: JSONSchemaTarget,
): unknown[] {
  const jsonSchema = schemaToJsonSchema(paramsSchema, componentSchemas, schemaTarget);
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

function inferPathParams(path: string): unknown[] {
  const paramNames = extractParamNames(path);
  if (paramNames.length === 0) return [];

  const splatNames = new Set(extractSplatParamNames(path));

  return paramNames.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: splatNames.has(name)
      ? toOpenAPIPathParamSchema(undefined)
      : { type: "string" },
  }));
}

function extractQueryParams(
  querySchema: StandardSchemaV1,
  componentSchemas: Record<string, unknown>,
  schemaTarget: JSONSchemaTarget,
): unknown[] {
  const jsonSchema = schemaToJsonSchema(querySchema, componentSchemas, schemaTarget);
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
// Schema conversion
// ---------------------------------------------------------------------------

/**
 * Convert a StandardSchemaV1 to JSON Schema, collecting any named definitions
 * into `componentSchemas` for hoisting into `components/schemas`.
 */
function schemaToJsonSchema(
  schema: StandardSchemaV1,
  componentSchemas: Record<string, unknown>,
  schemaTarget: JSONSchemaTarget,
): unknown | null {
  const std = schema["~standard"] as unknown as Record<string, unknown>;

  // 1. StandardJSONSchemaV1 — the generalized Standard Schema path.
  //    Libraries like Zod 4 expose .meta({ id }) → definitions/$ref here.
  if (
    "jsonSchema" in std &&
    std.jsonSchema &&
    typeof std.jsonSchema === "object" &&
    "output" in (std.jsonSchema as object) &&
    typeof (std.jsonSchema as Record<string, unknown>).output === "function"
  ) {
    try {
      const result = (std.jsonSchema as { output: (opts: { target: string }) => unknown }).output({
        target: schemaTarget,
      }) as Record<string, unknown>;

      return extractDefinitions(result, componentSchemas);
    } catch {
      // Fall through to next strategy
    }
  }

  // 2. Fallback: zod-to-json-schema for Zod 3
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
// Definition extraction — hoists named schemas into components/schemas
// ---------------------------------------------------------------------------

/**
 * Extract `definitions` from a JSON Schema result, move them into
 * `componentSchemas`, and rewrite `$ref` pointers from
 * `#/definitions/X` → `#/components/schemas/X`.
 */
function extractDefinitions(
  jsonSchema: Record<string, unknown>,
  componentSchemas: Record<string, unknown>,
): Record<string, unknown> {
  const { definitions, $defs, $schema, id, ...rest } = jsonSchema;

  for (const defsValue of [definitions, $defs]) {
    if (!defsValue || typeof defsValue !== "object") continue;

    const defs = defsValue as Record<string, unknown>;
    for (const [name, defSchema] of Object.entries(defs)) {
      const cleaned = { ...(defSchema as Record<string, unknown>) };
      delete cleaned.id;
      delete cleaned.$schema;
      componentSchemas[name] = rewriteRefs(cleaned);
    }
  }

  // When the root schema itself has an id, hoist it into components/schemas
  // and return a $ref pointer instead of the inline schema.
  if (typeof id === "string") {
    componentSchemas[id] = rewriteRefs(rest);
    return { $ref: `#/components/schemas/${id}` };
  }

  return rewriteRefs(rest) as Record<string, unknown>;
}

/**
 * Recursively rewrite `$ref: "#/definitions/X"` → `$ref: "#/components/schemas/X"`.
 */
function rewriteRefs(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map(rewriteRefs);
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    if (key === "$ref" && typeof val === "string") {
      if (val.startsWith("#/definitions/")) {
        result[key] = val.replace("#/definitions/", "#/components/schemas/");
        continue;
      }

      if (val.startsWith("#/$defs/")) {
        result[key] = val.replace("#/$defs/", "#/components/schemas/");
        continue;
      }
    }

    result[key] = rewriteRefs(val);
  }

  return result;
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

function getSchemaTarget(specVersion: OpenAPISpecVersion): JSONSchemaTarget {
  return specVersion === "3.0.3" ? "openapi-3.0" : "draft-2020-12";
}
