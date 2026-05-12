import { Hono } from "hono";
import type {
  Context,
  MiddlewareHandler as HonoMiddlewareHandler,
  TypedResponse,
} from "hono";
import { createMiddleware as createHonoMiddleware } from "hono/factory";
import type { StatusCode } from "hono/utils/http-status";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { composeRouteHandler, type RoutedMiddleware } from "../core/compose.ts";
import { BaseRouteContext } from "../core/context.ts";
import { RouteError } from "../core/error.ts";
import {
  compareRoutePathSpecificity,
  getPathname,
  matchRoutePath,
} from "../core/path.ts";
import { getResponseSchemaForStatus } from "../core/responses.ts";
import { validateSchema } from "../core/validate.ts";
import {
  createMiddlewareImportNameMap,
  createRouteImportNameMap,
  generateManifestSource,
} from "../codegen/manifest.ts";
import type {
  InferSchemaInput,
  InferSchemaOutput,
  InferResponsesOutput,
  MiddlewareDefinition,
  ResponseSchemaMap,
  RouteDefinition,
  RouteEntry,
  RouteSchemas,
  RouteTree,
} from "../core/types.ts";

// ---------------------------------------------------------------------------
// HonoRouteContext — concrete RouteContext backed by a Hono Context
// ---------------------------------------------------------------------------

class HonoRouteContext extends BaseRouteContext {
  readonly request: Request;
  readonly method: string;
  readonly path: string;
  readonly raw: Context;

  constructor(c: Context) {
    super();
    this.request = c.req.raw;
    this.method = c.req.method;
    this.path = c.req.path;
    this.raw = c;
  }

  override set(key: string, value: unknown): void {
    super.set(key, value);
    this.raw.set(key as never, value as never);
  }

  override get(key: string): unknown {
    if (this.hasState(key)) {
      return super.get(key);
    }

    const value = this.raw.get(key as never);
    if (value !== undefined) {
      return value;
    }

    throw new Error(`Context key "${key}" has not been set`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CreateHonoAppOptions = {
  /** Validate handler return values against response schemas. Off by default. */
  validateResponses?: boolean;
  /** Global middleware that runs before directory middleware for every route. */
  middleware?: MiddlewareDefinition<any, any>[];
};

type TypedAppRoute = {
  filePath: string;
  urlPath: string;
  method: string;
};

type TypedAppMiddleware = {
  filePath: string;
  directory: string;
};

type GenerateTypedAppInput = {
  routes: TypedAppRoute[];
  middlewares: TypedAppMiddleware[];
  outFile: string;
  routesDir: string;
};

type AwaitedReturn<T> = T extends Promise<infer U> ? AwaitedReturn<U> : T;

type ExcludeRawResponse<T> = Exclude<T, Response>;

type RouteHandlerOutput<TRoute extends RouteDefinition<any, any>> =
  ExcludeRawResponse<AwaitedReturn<ReturnType<TRoute["handler"]>>>;

type NormalizeStatusCode<T extends string | number> = T extends number
  ? T
  : T extends `${infer U extends number}`
    ? U
    : never;

type HonoInputShape<TSchemas extends RouteSchemas> =
  (TSchemas extends { body: infer TBody extends StandardSchemaV1 }
    ? { json: InferSchemaInput<TBody> }
    : {}) &
  (TSchemas extends { query: infer TQuery extends StandardSchemaV1 }
    ? { query: InferSchemaInput<TQuery> }
    : {});

type HonoRouteInput<TSchemas extends RouteSchemas> =
  keyof HonoInputShape<TSchemas> extends never
    ? {}
    : { in: HonoInputShape<TSchemas> };

type HonoResponseDataFromResponses<TSchemas extends RouteSchemas> =
  TSchemas extends { responses: infer TResponses extends ResponseSchemaMap }
    ? InferResponsesOutput<TResponses>
    : never;

type HonoResponseDataFromSchema<TSchemas extends RouteSchemas> =
  TSchemas extends { response: infer TResponse extends StandardSchemaV1 }
    ? InferSchemaOutput<TResponse>
    : never;

type HonoResponseData<TRoute extends RouteDefinition<any, any>> =
  TRoute["schemas"] extends infer TSchemas extends RouteSchemas
    ? [HonoResponseDataFromResponses<TSchemas>] extends [never]
      ? [HonoResponseDataFromSchema<TSchemas>] extends [never]
        ? RouteHandlerOutput<TRoute>
        : HonoResponseDataFromSchema<TSchemas>
      : HonoResponseDataFromResponses<TSchemas>
    : RouteHandlerOutput<TRoute>;

type HonoRouteResponse<TRoute extends RouteDefinition<any, any>> =
  [HonoResponseData<TRoute>] extends [never]
    ? TypedResponse
    : TypedResponse<HonoResponseData<TRoute>, StatusCode, "json">;

/**
 * Create a Hono app from a routed route tree.
 */
export function createHonoApp(
  routeTree: RouteTree,
  options?: CreateHonoAppOptions,
): Hono {
  const app = new Hono();
  const validateResponses = options?.validateResponses ?? false;
  const globalMiddleware = options?.middleware ?? [];

  const sortedRoutes = [...routeTree].sort((a, b) =>
    compareRoutePathSpecificity(a.path, b.path),
  );

  for (const entry of sortedRoutes) {
    registerRoute(app, entry, validateResponses, globalMiddleware);
  }

  return app;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function registerRoute(
  app: Hono,
  entry: RouteEntry,
  validateResponses: boolean,
  globalMiddleware: MiddlewareDefinition<any, any>[],
) {
  const { path: routePath, method, route, middleware: directoryMiddleware } = entry;
  const adapterRoutePath = translateRoutePathForHono(routePath);

  const chain: RoutedMiddleware<HonoRouteContext>[] = [];

  for (const mw of globalMiddleware) {
    chain.push(toRoutedMiddleware(mw));
  }

  for (const mw of directoryMiddleware) {
    chain.push(toRoutedMiddleware(mw));
  }

  for (const mw of route.middleware) {
    chain.push(toRoutedMiddleware(mw));
  }

  const terminalHandler = createTerminalHandler(route, routePath, validateResponses);
  const execute = composeRouteHandler(chain, terminalHandler);

  app.on(method, [adapterRoutePath], async (c) => {
    const ctx = new HonoRouteContext(c);
    try {
      const result = await execute(ctx);
      if (result instanceof Response) {
        return result;
      }

      if (result !== undefined && !ctx.hasBufferedResponseInit()) {
        return c.json(result as object);
      }

      if (result === undefined) {
        const headers = ctx.getBufferedHeaders();
        return new Response(null, {
          status: ctx.getBufferedStatus(),
          headers,
        });
      }

      ctx.forEachBufferedHeader((value, key) => {
        c.header(key, value);
      });
      c.status(ctx.getBufferedStatus() as never);
      return c.json(result as object);
    } catch (err) {
      if (err instanceof RouteError) {
        return c.json(
          { error: err.message, ...(err.data ? { data: err.data } : {}) },
          err.status as never,
        );
      }
      throw err;
    }
  });
}

function translateRoutePathForHono(path: string): string {
  return path.replace(/:(\w+)\*/g, ":$1{.+}");
}

function toRoutedMiddleware(
  mw: MiddlewareDefinition,
): RoutedMiddleware<HonoRouteContext> {
  return async (ctx, next) => {
    return mw.handler({ ctx, next });
  };
}

function createTerminalHandler(
  route: RouteDefinition<RouteSchemas>,
  routePath: string,
  validateResponses: boolean,
): (ctx: HonoRouteContext) => Promise<unknown> {
  return async (ctx) => {
    return executeRouteHandler(route, routePath, validateResponses, ctx);
  };
}

async function executeRouteHandler(
  route: RouteDefinition<RouteSchemas>,
  routePath: string,
  validateResponses: boolean,
  ctx: HonoRouteContext,
): Promise<unknown> {
  const { schemas } = route;
  const c = ctx.raw;

  // Validate and parse params
  let params: unknown;
  if (schemas.params) {
    const matchedParams = matchRoutePath(routePath, getPathname(c.req.raw.url));
    if (!matchedParams) {
      throw new RouteError(500, `Route matched but param extraction failed for ${c.req.method} ${routePath}`);
    }

    const result = await validateSchema(
      schemas.params,
      matchedParams,
    );
    if (!result.success) {
      return ctx.json(
        { error: "Validation failed", target: "params", issues: result.issues },
        400,
      );
    }
    params = result.data;
  }

  // Validate and parse query
  let query: unknown;
  if (schemas.query) {
    const result = await validateSchema(schemas.query, c.req.query());
    if (!result.success) {
      return ctx.json(
        { error: "Validation failed", target: "query", issues: result.issues },
        400,
      );
    }
    query = result.data;
  }

  // Validate and parse body
  let body: unknown;
  if (schemas.body) {
    const rawBody = await c.req.json().catch(() => null);
    const result = await validateSchema(schemas.body, rawBody);
    if (!result.success) {
      return ctx.json(
        { error: "Validation failed", target: "body", issues: result.issues },
        400,
      );
    }
    body = result.data;
  }

  const handlerResult = await route.handler({ params, query, body, ctx });

  if (handlerResult instanceof Response) {
    return handlerResult;
  }

  const responseSchema = validateResponses
    ? getResponseSchemaForStatus(schemas, ctx.getBufferedStatus())
    : undefined;

  if (responseSchema) {
    const validation = await validateSchema(responseSchema, handlerResult);
    if (!validation.success) {
      throw new RouteError(500, `Response validation failed for ${c.req.method} ${routePath}`, {
        issues: validation.issues,
      });
    }
  }

  return handlerResult;
}

// ---------------------------------------------------------------------------
// Standalone helpers — used by generated typed app code
// ---------------------------------------------------------------------------

/**
 * Wrap a routedjs route definition as a Hono handler.
 * Used by the generated typed app to preserve Hono's type chain.
 */
export function routeHandler<
  TRoute extends RouteDefinition<any, any>,
  TPath extends string,
>(
  route: TRoute,
  routePath: TPath,
  options?: { validateResponses?: boolean },
): (c: Context<any, TPath, HonoRouteInput<TRoute["schemas"]>>) => Promise<HonoRouteResponse<TRoute>> {
  const validateResponses = options?.validateResponses ?? false;

  const handler = async (
    c: Context<any, TPath, HonoRouteInput<TRoute["schemas"]>>,
  ): Promise<HonoRouteResponse<TRoute>> => {
    const ctx = new HonoRouteContext(c);

    // Run route-level middleware
    const chain: RoutedMiddleware<HonoRouteContext>[] = [];
    for (const mw of route.middleware) {
      chain.push(toRoutedMiddleware(mw));
    }

    const terminal = async (innerCtx: HonoRouteContext) => {
      return executeRouteHandler(route, routePath, validateResponses, innerCtx);
    };

    try {
      const execute = composeRouteHandler(chain, terminal);
      const result = await execute(ctx);

      if (result instanceof Response) {
        return result as unknown as HonoRouteResponse<TRoute>;
      }

      if (result !== undefined && !ctx.hasBufferedResponseInit()) {
        return c.json(result as object) as unknown as HonoRouteResponse<TRoute>;
      }

      if (result === undefined) {
        const headers = ctx.getBufferedHeaders();
        return new Response(null, { status: ctx.getBufferedStatus(), headers }) as unknown as HonoRouteResponse<TRoute>;
      }

      ctx.forEachBufferedHeader((value, key) => {
        c.header(key, value);
      });
      c.status(ctx.getBufferedStatus() as never);
      return c.json(result as object) as unknown as HonoRouteResponse<TRoute>;
    } catch (err) {
      if (err instanceof RouteError) {
        return c.json(
          { error: err.message, ...(err.data ? { data: err.data } : {}) },
          err.status as never,
        ) as unknown as HonoRouteResponse<TRoute>;
      }
      throw err;
    }
  };

  return handler;
}

/**
 * Wrap a routedjs middleware definition as a Hono middleware handler.
 * Used by the generated typed app to preserve Hono's type chain.
 */
export function wrapMiddleware(
  mw: MiddlewareDefinition<any, any>,
): HonoMiddlewareHandler<any, any> {
  return createHonoMiddleware(async (c, next) => {
    const ctx = new HonoRouteContext(c);
    await mw.handler({ ctx, next });
  }) as HonoMiddlewareHandler<any, any>;
}

/** @internal Adapter-owned app codegen hook used by the CLI. */
export async function generateTypedApp(input: GenerateTypedAppInput): Promise<string> {
  const path = await import("node:path");
  const { routes, middlewares, outFile, routesDir } = input;
  const lines = [
    generateManifestSource(routes, middlewares, outFile, routesDir, [
      'import { Hono } from "hono";',
      'import { routeHandler, wrapMiddleware } from "routedjs/hono";',
    ]).trimEnd(),
    "",
  ];

  lines.push("export const app = new Hono()");

  const middlewareImportNames = createMiddlewareImportNameMap(middlewares, routesDir);
  const routeImportNames = createRouteImportNameMap(routes, routesDir);

  for (const mw of middlewares) {
    const usePaths = resolveMiddlewareUsePaths(path, mw, routes);
    for (const usePath of usePaths) {
      lines.push(`  .use("${usePath}", wrapMiddleware(${middlewareImportNames.get(mw.filePath)!}))`);
    }
  }

  routes.forEach((route) => {
    lines.push(
      `  .${route.method}("${translateRoutePathForHono(route.urlPath)}", routeHandler(${routeImportNames.get(route.filePath)!}, "${route.urlPath}"))`,
    );
  });

  lines.push(";");
  lines.push("");
  lines.push("export type AppType = typeof app;");
  lines.push("");

  return lines.join("\n");
}

/**
 * Derive the Hono `.use()` path patterns for a middleware.
 * For root middleware → ["*"].
 * For pathless groups (like _authenticated) → collect the unique
 * top-level URL prefixes of all routes the middleware applies to.
 */
function resolveMiddlewareUsePaths(
  path: typeof import("node:path"),
  mw: TypedAppMiddleware,
  routes: TypedAppRoute[],
): string[] {
  if (mw.directory === ".") return ["*"];

  // Check if the directory has any non-pathless URL segments
  const segments = mw.directory
    .split(path.sep)
    .filter(Boolean)
    .filter((s) => !s.startsWith("_"))
    .map((s) => s.startsWith("$$") ? `:${s.slice(2)}{.+}` : s.startsWith("$") ? `:${s.slice(1)}` : s);

  if (segments.length > 0) {
    const prefix = "/" + segments.join("/");
    return [prefix.endsWith("{.+}") ? prefix : `${prefix}/*`];
  }

  // Pathless group — derive from the routes this middleware covers
  const prefixes = new Set<string>();
  for (const route of routes) {
    const routeDir = path.relative(
      path.resolve(mw.filePath, ".."),
      path.dirname(route.filePath),
    );
    // Only include routes under this middleware's directory
    if (routeDir.startsWith("..")) continue;

    const firstSegment = route.urlPath.split("/").filter(Boolean)[0];
    if (firstSegment) {
      prefixes.add(`/${firstSegment}/*`);
    }
  }

  return prefixes.size > 0 ? [...prefixes].sort() : ["*"];
}
