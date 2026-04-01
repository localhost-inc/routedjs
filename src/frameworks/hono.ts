import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware as createHonoMiddleware } from "hono/factory";
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
import { generateManifestSource } from "../codegen/manifest.ts";
import type {
  MiddlewareDefinition,
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
export function routeHandler(
  route: RouteDefinition<RouteSchemas>,
  routePath: string,
  options?: { validateResponses?: boolean },
) {
  const validateResponses = options?.validateResponses ?? false;

  return async (c: Context) => {
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

      if (result instanceof Response) return result;

      if (result !== undefined && !ctx.hasBufferedResponseInit()) {
        return c.json(result as object);
      }

      if (result === undefined) {
        const headers = ctx.getBufferedHeaders();
        return new Response(null, { status: ctx.getBufferedStatus(), headers });
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
  };
}

/**
 * Wrap a routedjs middleware definition as a Hono middleware handler.
 * Used by the generated typed app to preserve Hono's type chain.
 */
export function wrapMiddleware(mw: MiddlewareDefinition<any, any>) {
  return createHonoMiddleware(async (c, next) => {
    const ctx = new HonoRouteContext(c);
    await mw.handler({ ctx, next });
  });
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

  for (let index = 0; index < middlewares.length; index++) {
    const mw = middlewares[index]!;
    const usePaths = resolveMiddlewareUsePaths(path, mw, routes);
    for (const usePath of usePaths) {
      lines.push(`  .use("${usePath}", wrapMiddleware(middleware${index}))`);
    }
  }

  routes.forEach((route, index) => {
    lines.push(
      `  .${route.method}("${translateRoutePathForHono(route.urlPath)}", routeHandler(route${index}, "${route.urlPath}"))`,
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
