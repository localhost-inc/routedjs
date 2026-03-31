import { Hono } from "hono";
import type { Context } from "hono";
import { BaseRouteContext } from "../core/context.ts";
import { RouteError } from "../core/error.ts";
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

  for (const entry of routeTree) {
    registerRoute(app, entry, validateResponses, globalMiddleware);
  }

  return app;
}

// ---------------------------------------------------------------------------
// Compose — Koa-style compose that threads return values back up
// ---------------------------------------------------------------------------

type RoutedMiddleware = (
  ctx: HonoRouteContext,
  next: () => Promise<unknown>,
) => unknown | Promise<unknown>;

function compose(
  middlewares: RoutedMiddleware[],
  handler: (ctx: HonoRouteContext) => unknown | Promise<unknown>,
): (ctx: HonoRouteContext) => Promise<unknown> {
  return async (ctx: HonoRouteContext) => {
    let index = -1;

    async function dispatch(i: number): Promise<unknown> {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;

      if (i === middlewares.length) {
        return handler(ctx);
      }

      const mw = middlewares[i]!;
      let downstreamResult: unknown;
      const result = await mw(ctx, async () => {
        downstreamResult = await dispatch(i + 1);
        return downstreamResult;
      });
      return result !== undefined ? result : downstreamResult;
    }

    return dispatch(0);
  };
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

  const chain: RoutedMiddleware[] = [];

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

  app.on(method, [routePath], async (c) => {
    const ctx = new HonoRouteContext(c);
    try {
      const result = await compose(chain, terminalHandler)(ctx);

      if (result instanceof Response) {
        return result;
      }
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

function toRoutedMiddleware(mw: MiddlewareDefinition): RoutedMiddleware {
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
      const result = await validateSchema(schemas.params, c.req.param());
      if (!result.success) {
        return c.json(
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
        return c.json(
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
        return c.json(
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
