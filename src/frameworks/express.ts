import express from "express";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
  RequestHandler,
  Application,
} from "express";
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
import {
  applyResponseHeaders,
  NodeRequestState,
  pipeResponseBody,
} from "./node.ts";
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
  readonly method: string;
  readonly path: string;
  readonly raw: { req: ExpressRequest; res: ExpressResponse };
  private requestState?: NodeRequestState;

  constructor(req: ExpressRequest, res: ExpressResponse) {
    super();
    this.method = req.method;
    this.path = req.path;
    this.raw = { req, res };
  }

  get request(): globalThis.Request {
    return this.getRequestState().request;
  }

  override header(name: string): string | undefined {
    const value = this.raw.req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value ?? undefined;
  }

  readJsonBody(): Promise<unknown> {
    return this.getRequestState().readJsonBody();
  }

  private getRequestState(): NodeRequestState {
    this.requestState ??= new NodeRequestState(
      `${this.raw.req.protocol}://${this.raw.req.get("host")}${this.raw.req.originalUrl}`,
      this.method,
      this.raw.req.headers,
      this.raw.req,
    );
    return this.requestState;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type CreateExpressAppOptions = {
  /** Validate handler return values against response schemas. Off by default. */
  validateResponses?: boolean;
  /** Global middleware that runs BEFORE directory middleware for every route. */
  middleware?: MiddlewareDefinition<any, any>[];
};

/**
 * Create an Express app from a routed route tree.
 */
export function createExpressApp(routeTree: RouteTree, options?: CreateExpressAppOptions): Application {
  const app = express();
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
// Route registration
// ---------------------------------------------------------------------------

function registerRoute(
  app: Application,
  entry: RouteEntry,
  validateResponses: boolean,
  globalMiddleware: MiddlewareDefinition<any, any>[],
) {
  const { path: routePath, method, route, middleware: directoryMiddleware } = entry;
  const adapterRoutePath = translateRoutePathForExpress(routePath);
  const chain: RoutedMiddleware<ExpressRouteContext>[] = [
    ...globalMiddleware,
    ...directoryMiddleware,
    ...route.middleware,
  ].map(toRoutedMiddleware);
  const execute = composeRouteHandler(
    chain,
    async (routeCtx) => runHandler(route, routeCtx, routePath, method, validateResponses),
  );

  const handler: RequestHandler = async (req, res, next) => {
    const ctx = new ExpressRouteContext(req, res);

    try {
      const result = await execute(ctx);
      if (!res.headersSent) {
        await sendResult(res, ctx, result);
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

  app[method](adapterRoutePath, handler);
}

function translateRoutePathForExpress(path: string): string {
  return path.replace(/:(\w+)\*/g, "*$1");
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function toRoutedMiddleware(
  middleware: MiddlewareDefinition,
): RoutedMiddleware<ExpressRouteContext> {
  return async (ctx, next) => {
    return middleware.handler({ ctx, next });
  };
}

// ---------------------------------------------------------------------------
// Send result as response
// ---------------------------------------------------------------------------

async function sendResult(
  res: ExpressResponse,
  ctx: ExpressRouteContext,
  result: unknown,
): Promise<void> {
  if (result instanceof Response) {
    await sendResponse(res, result);
    return;
  }

  if (result === undefined) {
    if (ctx.hasBufferedResponseInit()) {
      res.status(ctx.getBufferedStatus());
      ctx.forEachBufferedHeader((value, key) => {
        res.setHeader(key, value);
      });
    }
    res.end();
    return;
  }

  if (ctx.hasBufferedResponseInit()) {
    res.status(ctx.getBufferedStatus());
    ctx.forEachBufferedHeader((value, key) => {
      res.setHeader(key, value);
    });
  }

  res.json(result);
}

async function sendResponse(res: ExpressResponse, response: Response): Promise<void> {
  res.status(response.status);
  applyResponseHeaders(response, (name, value) => {
    res.setHeader(name, value);
  });
  await pipeResponseBody(response, res);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Wrap a routedjs route definition as an Express handler.
 * Used by the generated typed app.
 */
export function routeHandler(
  route: RouteDefinition<RouteSchemas>,
  routePath: string,
  options?: { validateResponses?: boolean },
): RequestHandler {
  const validateResponses = options?.validateResponses ?? false;
  const chain: RoutedMiddleware<ExpressRouteContext>[] = route.middleware.map(toRoutedMiddleware);

  return async (req, res, next) => {
    const ctx = new ExpressRouteContext(req, res);
    const execute = composeRouteHandler(
      chain,
      async (routeCtx) => runHandler(route, routeCtx, routePath, req.method, validateResponses),
    );

    try {
      const result = await execute(ctx);
      if (!res.headersSent) await sendResult(res, ctx, result);
    } catch (err) {
      if (err instanceof RouteError) {
        if (!res.headersSent) {
          res.status(err.status).json({ error: err.message, ...(err.data ? { data: err.data } : {}) });
        }
        return;
      }
      next(err);
    }
  };
}

/**
 * Wrap a routedjs middleware definition as Express middleware.
 * Used by the generated typed app.
 */
export function wrapMiddleware(mw: MiddlewareDefinition<any, any>): RequestHandler {
  return async (req, res, next) => {
    const ctx = new ExpressRouteContext(req, res);
    try {
      await mw.handler({ ctx, next: async () => { await next(); } });
    } catch (err) {
      next(err);
    }
  };
}

/** @internal Adapter-owned app codegen hook used by the CLI. */
export async function generateTypedApp(input: {
  routes: { filePath: string; urlPath: string; method: string }[];
  middlewares: { filePath: string; directory: string }[];
  outFile: string;
  routesDir: string;
}): Promise<string> {
  const path = await import("node:path");
  const { routes, middlewares, outFile, routesDir } = input;
  const lines = [
    generateManifestSource(routes, middlewares, outFile, routesDir, [
      'import express from "express";',
      'import { routeHandler, wrapMiddleware } from "routedjs/express";',
    ]).trimEnd(),
    "",
  ];

  lines.push("export const app = express();");
  lines.push("");

  const middlewareImportNames = createMiddlewareImportNameMap(middlewares, routesDir);
  const routeImportNames = createRouteImportNameMap(routes, routesDir);

  middlewares.forEach((mw) => {
    const usePath = dirToUsePath(path, mw.directory);
    lines.push(`app.use("${usePath}", wrapMiddleware(${middlewareImportNames.get(mw.filePath)!}));`);
  });

  routes.forEach((route) => {
    const expressPath = route.urlPath.replace(/:(\w+)\*/g, "*$1");
    lines.push(`app.${route.method}("${expressPath}", routeHandler(${routeImportNames.get(route.filePath)!}, "${route.urlPath}"));`);
  });

  lines.push("");
  return lines.join("\n");
}

function dirToUsePath(p: typeof import("node:path"), directory: string): string {
  if (directory === ".") return "*";
  const segments = directory.split(p.sep).filter(Boolean).filter((s) => !s.startsWith("_"))
    .map((s) => s.startsWith("$$") ? `:${s.slice(2)}*` : s.startsWith("$") ? `:${s.slice(1)}` : s);
  if (segments.length === 0) return "*";
  return `/${segments.join("/")}/*`;
}

async function runHandler(
  route: RouteDefinition<RouteSchemas>,
  ctx: ExpressRouteContext,
  routePath: string,
  method: string,
  validateResponses: boolean,
): Promise<unknown> {
  const { schemas } = route;
  const req = ctx.raw.req;

  let params: unknown;
  if (schemas.params) {
    const matchedParams = matchRoutePath(routePath, getPathname(req.url));
    if (!matchedParams) {
      throw new RouteError(500, `Route matched but param extraction failed for ${method.toUpperCase()} ${routePath}`);
    }

    const result = await validateSchema(
      schemas.params,
      matchedParams,
    );
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
    const result = await validateSchema(schemas.body, await ctx.readJsonBody());
    if (!result.success) {
      return ctx.json({ error: "Validation failed", target: "body", issues: result.issues }, 400);
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
      throw new RouteError(500, `Response validation failed for ${method.toUpperCase()} ${routePath}`, {
        issues: validation.issues,
      });
    }
  }

  return handlerResult;
}
