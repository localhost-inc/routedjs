import Elysia from "elysia";
import type { Context as ElysiaContext } from "elysia";
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
// ElysiaRouteContext — concrete RouteContext backed by Elysia's context
// ---------------------------------------------------------------------------

class ElysiaRouteContext extends BaseRouteContext {
  readonly request: Request;
  readonly method: string;
  readonly path: string;
  readonly raw: ElysiaContext;

  constructor(elysiaCtx: ElysiaContext) {
    super();
    this.request = elysiaCtx.request;
    this.method = elysiaCtx.request.method;
    this.path = new URL(elysiaCtx.request.url).pathname;
    this.raw = elysiaCtx;
  }
}

type CreateElysiaAppOptions = {
  /** Validate handler return values against response schemas. Off by default. */
  validateResponses?: boolean;
  /** Global middleware that runs BEFORE directory middleware for every route. */
  middleware?: MiddlewareDefinition<any>[];
};

/**
 * Create an Elysia app from a routed route tree.
 */
export function createElysiaApp(routeTree: RouteTree, options?: CreateElysiaAppOptions): Elysia {
  let app = new Elysia();
  const validateResponses = options?.validateResponses ?? false;
  const globalMiddleware = options?.middleware ?? [];

  for (const entry of routeTree) {
    app = registerRoute(app, entry, validateResponses, globalMiddleware);
  }

  return app;
}

function registerRoute(
  app: Elysia,
  entry: RouteEntry,
  validateResponses: boolean,
  globalMiddleware: MiddlewareDefinition<any>[],
): Elysia {
  const { path: routePath, method, route, middleware: directoryMiddleware } = entry;

  const chain: MiddlewareDefinition[] = [
    ...globalMiddleware,
    ...directoryMiddleware,
    ...route.middleware,
  ];

  const handler = async (elysiaCtx: ElysiaContext) => {
    const ctx = new ElysiaRouteContext(elysiaCtx);

    const terminalHandler = async (_routeCtx: ElysiaRouteContext): Promise<unknown> => {
      return runHandler(elysiaCtx, route, _routeCtx, routePath, validateResponses);
    };

    try {
      const result = await compose(chain, terminalHandler)(ctx);

      if (result instanceof Response) {
        return result;
      }

      return result;
    } catch (err) {
      if (err instanceof RouteError) {
        elysiaCtx.set.status = err.status;
        return {
          error: err.message,
          ...(err.data ? { data: err.data } : {}),
        };
      }
      throw err;
    }
  };

  const methodUpper = method.toUpperCase();
  return app.route(methodUpper, routePath, handler as never);
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

function compose(
  middlewares: MiddlewareDefinition[],
  handler: (ctx: ElysiaRouteContext) => Promise<unknown>,
): (ctx: ElysiaRouteContext) => Promise<unknown> {
  return async (ctx) => {
    let index = -1;

    async function dispatch(i: number): Promise<unknown> {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;

      if (i >= middlewares.length) return handler(ctx);

      let handlerResult: unknown;
      const mwResult = await middlewares[i]!.handler({
        ctx,
        next: async () => {
          handlerResult = await dispatch(i + 1);
          return handlerResult;
        },
      });
      return mwResult !== undefined ? mwResult : handlerResult;
    }

    return dispatch(0);
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function runHandler(
  elysiaCtx: ElysiaContext,
  route: RouteDefinition<RouteSchemas>,
  ctx: ElysiaRouteContext,
  routePath: string,
  validateResponses: boolean,
): Promise<unknown> {
  const { schemas } = route;

  let params: unknown;
  if (schemas.params) {
    const result = await validateSchema(schemas.params, elysiaCtx.params);
    if (!result.success) {
      elysiaCtx.set.status = 400;
      return { error: "Validation failed", target: "params", issues: result.issues };
    }
    params = result.data;
  }

  let query: unknown;
  if (schemas.query) {
    const result = await validateSchema(schemas.query, elysiaCtx.query);
    if (!result.success) {
      elysiaCtx.set.status = 400;
      return { error: "Validation failed", target: "query", issues: result.issues };
    }
    query = result.data;
  }

  let body: unknown;
  if (schemas.body) {
    let rawBody: unknown = elysiaCtx.body;
    if (rawBody === undefined || rawBody === null) {
      try {
        rawBody = await elysiaCtx.request.clone().json();
      } catch {
        rawBody = null;
      }
    }
    const result = await validateSchema(schemas.body, rawBody);
    if (!result.success) {
      elysiaCtx.set.status = 400;
      return { error: "Validation failed", target: "body", issues: result.issues };
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
      throw new RouteError(500, `Response validation failed for ${elysiaCtx.request.method} ${routePath}`, {
        issues: validation.issues,
      });
    }
  }

  return handlerResult;
}
