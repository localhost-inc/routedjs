import Koa from "koa";
import type { Context as KoaContext } from "koa";
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
// KoaRouteContext — concrete RouteContext backed by a Koa Context
// ---------------------------------------------------------------------------

class KoaRouteContext extends BaseRouteContext {
  readonly method: string;
  readonly path: string;
  readonly params: Record<string, unknown>;
  readonly raw: KoaContext;
  private requestState?: NodeRequestState;

  constructor(koaCtx: KoaContext, params: Record<string, unknown>) {
    super();
    this.method = koaCtx.method;
    this.path = koaCtx.path;
    this.params = params;
    this.raw = koaCtx;
  }

  get request(): Request {
    return this.getRequestState().request;
  }

  override header(name: string): string | undefined {
    const value = this.raw.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value ?? undefined;
  }

  readJsonBody(): Promise<unknown> {
    return this.getRequestState().readJsonBody();
  }

  private getRequestState(): NodeRequestState {
    this.requestState ??= new NodeRequestState(
      `${this.raw.protocol}://${this.raw.host}${this.raw.originalUrl ?? this.raw.url}`,
      this.method,
      this.raw.headers,
      this.raw.req,
    );
    return this.requestState;
  }
}

// ---------------------------------------------------------------------------
// Symbol used to store the shared RouteContext on the Koa context
// ---------------------------------------------------------------------------

const ROUTE_CTX = Symbol.for("routed:ctx");

function setRouteCtx(koaCtx: KoaContext, ctx: KoaRouteContext): void {
  (koaCtx as unknown as Record<symbol, KoaRouteContext>)[ROUTE_CTX] = ctx;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type CreateKoaAppOptions = {
  /** Validate handler return values against response schemas. Off by default. */
  validateResponses?: boolean;
  /** Global middleware that runs before directory middleware for every route. */
  middleware?: MiddlewareDefinition<any, any>[];
};

/**
 * Create a Koa app from a routed route tree.
 */
export function createKoaApp(routeTree: RouteTree, options?: CreateKoaAppOptions): Koa {
  const app = new Koa();
  const validateResponses = options?.validateResponses ?? false;
  const globalMiddleware = options?.middleware ?? [];

  const routes = routeTree.map((entry) => {
    const chain: RoutedMiddleware<KoaRouteContext>[] = [
      ...globalMiddleware,
      ...entry.middleware,
      ...entry.route.middleware,
    ].map(toRoutedMiddleware);

    return {
      ...entry,
      pattern: (pathname: string) => matchRoutePath(entry.path, pathname),
      execute: composeRouteHandler(
        chain,
        createTerminalHandler(entry.route, entry.path, validateResponses),
      ),
    };
  }).sort((a, b) => compareRoutePathSpecificity(a.path, b.path));

  app.use(async (koaCtx, next) => {
    const method = koaCtx.method.toLowerCase();
    const pathname = getPathname(koaCtx.req.url ?? koaCtx.url);

    for (const route of routes) {
      if (route.method !== method) continue;

      const params = route.pattern(pathname);
      if (!params) continue;

      const routeCtx = new KoaRouteContext(koaCtx, params);
      setRouteCtx(koaCtx, routeCtx);

      try {
        const result = await route.execute(routeCtx);
        await sendResult(koaCtx, routeCtx, result);
      } catch (err) {
        if (err instanceof RouteError) {
          koaCtx.status = err.status;
          koaCtx.body = { error: err.message, ...(err.data ? { data: err.data } : {}) };
          return;
        }
        throw err;
      }
      return;
    }

    await next();
  });

  return app;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function toRoutedMiddleware(
  mw: MiddlewareDefinition,
): RoutedMiddleware<KoaRouteContext> {
  return async (ctx, next) => {
    return mw.handler({ ctx, next });
  };
}

function createTerminalHandler(
  route: RouteDefinition<RouteSchemas>,
  routePath: string,
  validateResponses: boolean,
): (ctx: KoaRouteContext) => Promise<unknown> {
  return async (ctx) => {
    const { schemas } = route;
    const koaCtx = ctx.raw;

    // Validate params
    let params: unknown;
    if (schemas.params) {
      const result = await validateSchema(schemas.params, ctx.params);
      if (!result.success) {
        return validationErrorResponse("params", result.issues);
      }
      params = result.data;
    }

    // Validate query
    let query: unknown;
    if (schemas.query) {
      const result = await validateSchema(schemas.query, koaCtx.query);
      if (!result.success) {
        return validationErrorResponse("query", result.issues);
      }
      query = result.data;
    }

    // Validate body
    let body: unknown;
    if (schemas.body) {
      const result = await validateSchema(schemas.body, await ctx.readJsonBody());
      if (!result.success) {
        return validationErrorResponse("body", result.issues);
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
        throw new RouteError(500, `Response validation failed for ${koaCtx.method} ${routePath}`, {
          issues: validation.issues,
        });
      }
    }

    return handlerResult;
  };
}

function validationErrorResponse(target: string, issues: readonly unknown[]): Response {
  return new Response(
    JSON.stringify({ error: "Validation failed", target, issues }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

async function sendResponse(koaCtx: KoaContext, response: Response): Promise<void> {
  koaCtx.respond = false;
  koaCtx.res.statusCode = response.status;
  applyResponseHeaders(response, (name, value) => {
    koaCtx.res.setHeader(name, value);
  });
  await pipeResponseBody(response, koaCtx.res);
}

async function sendResult(
  koaCtx: KoaContext,
  ctx: KoaRouteContext,
  result: unknown,
): Promise<void> {
  if (result instanceof Response) {
    await sendResponse(koaCtx, result);
    return;
  }

  if (result === undefined) {
    if (ctx.hasBufferedResponseInit()) {
      koaCtx.status = ctx.getBufferedStatus();
      ctx.forEachBufferedHeader((value, key) => {
        koaCtx.set(key, value);
      });
    } else {
      koaCtx.status = 200;
    }
    koaCtx.body = null;
    return;
  }

  if (ctx.hasBufferedResponseInit()) {
    koaCtx.status = ctx.getBufferedStatus();
    ctx.forEachBufferedHeader((value, key) => {
      koaCtx.set(key, value);
    });
  }

  koaCtx.body = result;
}

/**
 * Wrap a routedjs route definition as a Koa middleware.
 * Used by the generated typed app.
 */
export function routeHandler(
  route: RouteDefinition<RouteSchemas>,
  routePath: string,
  method: string,
  options?: { validateResponses?: boolean },
) {
  const validateResponses = options?.validateResponses ?? false;
  const chain: RoutedMiddleware<KoaRouteContext>[] = route.middleware.map(toRoutedMiddleware);
  const execute = composeRouteHandler(
    chain,
    createTerminalHandler(route, routePath, validateResponses),
  );

  return async (koaCtx: KoaContext, next: () => Promise<unknown>) => {
    if (koaCtx.method.toLowerCase() !== method) return next();
    const pathname = getPathname(koaCtx.req.url ?? koaCtx.url);
    const params = matchRoutePath(routePath, pathname);
    if (!params) return next();

    const ctx = new KoaRouteContext(koaCtx, params);
    setRouteCtx(koaCtx, ctx);

    try {
      const result = await execute(ctx);
      await sendResult(koaCtx, ctx, result);
    } catch (err) {
      if (err instanceof RouteError) {
        koaCtx.status = err.status;
        koaCtx.body = { error: err.message, ...(err.data ? { data: err.data } : {}) };
        return;
      }
      throw err;
    }
  };
}

/**
 * Wrap a routedjs middleware definition as Koa middleware.
 * Used by the generated typed app.
 */
export function wrapMiddleware(mw: MiddlewareDefinition<any, any>) {
  return async (koaCtx: KoaContext, next: () => Promise<unknown>) => {
    const ctx = new KoaRouteContext(koaCtx, {});
    await mw.handler({ ctx, next });
  };
}

/** @internal Adapter-owned app codegen hook used by the CLI. */
export async function generateTypedApp(input: {
  routes: { filePath: string; urlPath: string; method: string }[];
  middlewares: { filePath: string; directory: string }[];
  outFile: string;
  routesDir: string;
}): Promise<string> {
  const { routes, middlewares, outFile, routesDir } = input;
  const lines = [
    generateManifestSource(routes, middlewares, outFile, routesDir, [
      'import Koa from "koa";',
      'import { routeHandler, wrapMiddleware } from "routedjs/koa";',
    ]).trimEnd(),
    "",
  ];

  lines.push("export const app = new Koa();");
  lines.push("");

  const middlewareImportNames = createMiddlewareImportNameMap(middlewares, routesDir);
  const routeImportNames = createRouteImportNameMap(routes, routesDir);

  middlewares.forEach((mw) => {
    lines.push(`app.use(wrapMiddleware(${middlewareImportNames.get(mw.filePath)!}));`);
  });

  routes.forEach((route) => {
    lines.push(`app.use(routeHandler(${routeImportNames.get(route.filePath)!}, "${route.urlPath}", "${route.method}"));`);
  });

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
