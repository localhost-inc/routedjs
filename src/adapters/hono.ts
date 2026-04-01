import { Hono } from "hono";
import type { Context } from "hono";
import { composeRouteHandler, type RoutedMiddleware } from "../core/compose.ts";
import { BaseRouteContext } from "../core/context.ts";
import { RouteError } from "../core/error.ts";
import {
  compareRoutePathSpecificity,
  getPathname,
  matchRoutePath,
} from "../core/path.ts";
import { validateSchema } from "../core/validate.ts";
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
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type CreateHonoAppOptions = {
  /** Validate handler return values against response schemas. Off by default. */
  validateResponses?: boolean;
  /** Global middleware that runs before directory middleware for every route. */
  middleware?: MiddlewareDefinition<any>[];
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
  globalMiddleware: MiddlewareDefinition<any>[],
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

    if (validateResponses && schemas.response) {
      const validation = await validateSchema(schemas.response, handlerResult);
      if (!validation.success) {
        throw new RouteError(500, `Response validation failed for ${c.req.method} ${routePath}`, {
          issues: validation.issues,
        });
      }
    }

    return handlerResult;
  };
}
