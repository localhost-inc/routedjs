import express from "express";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
  RequestHandler,
  Application,
} from "express";
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
// ExpressRouteContext — concrete RouteContext backed by Express req/res
// ---------------------------------------------------------------------------

class ExpressRouteContext extends BaseRouteContext {
  readonly request: globalThis.Request;
  readonly method: string;
  readonly path: string;
  readonly raw: { req: ExpressRequest; res: ExpressResponse };

  constructor(req: ExpressRequest, res: ExpressResponse) {
    super();
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }
    }
    this.request = new globalThis.Request(url, {
      method: req.method,
      headers,
    });
    this.method = req.method;
    this.path = req.path;
    this.raw = { req, res };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type CreateExpressAppOptions = {
  /** Validate handler return values against response schemas. Off by default. */
  validateResponses?: boolean;
  /** Global middleware that runs BEFORE directory middleware for every route. */
  middleware?: MiddlewareDefinition<any>[];
};

/**
 * Create an Express app from a routed route tree.
 */
export function createExpressApp(routeTree: RouteTree, options?: CreateExpressAppOptions): Application {
  const app = express();
  const validateResponses = options?.validateResponses ?? false;
  const globalMiddleware = options?.middleware ?? [];

  app.use(express.json());

  for (const entry of routeTree) {
    registerRoute(app, entry, validateResponses, globalMiddleware);
  }

  return app;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

function registerRoute(
  app: Application,
  entry: RouteEntry,
  validateResponses: boolean,
  globalMiddleware: MiddlewareDefinition<any>[],
) {
  const { path: routePath, method, route, middleware: directoryMiddleware } = entry;

  const handler: RequestHandler = async (req, res, next) => {
    const ctx = new ExpressRouteContext(req, res);

    const chain: MiddlewareDefinition[] = [
      ...globalMiddleware,
      ...directoryMiddleware,
      ...route.middleware,
    ];

    const terminalHandler = async (routeCtx: ExpressRouteContext): Promise<unknown> => {
      return runHandler(req, route, routeCtx, routePath, method, validateResponses);
    };

    try {
      const result = await compose(chain, terminalHandler)(ctx);
      if (!res.headersSent) {
        await sendResult(res, result);
      }
    } catch (err) {
      if (err instanceof RouteError) {
        if (!res.headersSent) {
          res.status(err.status).json({
            error: err.message,
            ...(err.data ? { data: err.data } : {}),
          });
        }
        return;
      }
      next(err);
    }
  };

  app[method](routePath, handler);
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

function compose(
  middlewares: MiddlewareDefinition[],
  handler: (ctx: ExpressRouteContext) => Promise<unknown>,
): (ctx: ExpressRouteContext) => Promise<unknown> {
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
// Send result as response
// ---------------------------------------------------------------------------

async function sendResult(res: ExpressResponse, result: unknown): Promise<void> {
  if (result instanceof Response) {
    result.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const text = await result.text();
    res.status(result.status);
    if (result.headers.get("content-type")?.includes("application/json")) {
      res.json(JSON.parse(text));
    } else {
      res.send(text);
    }
  } else if (result !== undefined) {
    res.json(result);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function runHandler(
  req: ExpressRequest,
  route: RouteDefinition<RouteSchemas>,
  ctx: ExpressRouteContext,
  routePath: string,
  method: string,
  validateResponses: boolean,
): Promise<unknown> {
  const { schemas } = route;

  let params: unknown;
  if (schemas.params) {
    const result = await validateSchema(schemas.params, req.params);
    if (!result.success) {
      return new Response(
        JSON.stringify({ error: "Validation failed", target: "params", issues: result.issues }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    params = result.data;
  }

  let query: unknown;
  if (schemas.query) {
    const result = await validateSchema(schemas.query, req.query);
    if (!result.success) {
      return new Response(
        JSON.stringify({ error: "Validation failed", target: "query", issues: result.issues }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    query = result.data;
  }

  let body: unknown;
  if (schemas.body) {
    const result = await validateSchema(schemas.body, req.body);
    if (!result.success) {
      return new Response(
        JSON.stringify({ error: "Validation failed", target: "body", issues: result.issues }),
        { status: 400, headers: { "content-type": "application/json" } },
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
      throw new RouteError(500, `Response validation failed for ${method.toUpperCase()} ${routePath}`, {
        issues: validation.issues,
      });
    }
  }

  return handlerResult;
}
