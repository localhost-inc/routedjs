import Koa from "koa";
import type { Context as KoaContext } from "koa";
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
// KoaRouteContext — concrete RouteContext backed by a Koa Context
// ---------------------------------------------------------------------------

class KoaRouteContext extends BaseRouteContext {
  readonly request: Request;
  readonly method: string;
  readonly path: string;
  readonly raw: KoaContext;

  constructor(koaCtx: KoaContext) {
    super();
    this.method = koaCtx.method;
    this.path = koaCtx.path;
    this.raw = koaCtx;

    const url = `${koaCtx.protocol}://${koaCtx.host}${koaCtx.originalUrl ?? koaCtx.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(koaCtx.headers)) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          for (const v of value) {
            headers.append(key, v);
          }
        } else {
          headers.set(key, value);
        }
      }
    }
    this.request = new Request(url, { method: koaCtx.method, headers });
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
  middleware?: MiddlewareDefinition<any>[];
};

/**
 * Create a Koa app from a routed route tree.
 */
export function createKoaApp(routeTree: RouteTree, options?: CreateKoaAppOptions): Koa {
  const app = new Koa();
  const validateResponses = options?.validateResponses ?? false;
  const globalMiddleware = options?.middleware ?? [];

  const routes = routeTree.map((entry) => ({
    ...entry,
    pattern: compilePattern(entry.path),
  }));

  app.use(async (koaCtx, next) => {
    const method = koaCtx.method.toLowerCase();
    const pathname = koaCtx.path;

    for (const route of routes) {
      if (route.method !== method) continue;

      const params = route.pattern(pathname);
      if (!params) continue;

      await executeRoute(koaCtx, route, params, validateResponses, globalMiddleware);
      return;
    }

    await next();
  });

  return app;
}

// ---------------------------------------------------------------------------
// Pattern matching (simple :param support)
// ---------------------------------------------------------------------------

type PatternMatcher = (pathname: string) => Record<string, string> | null;

function compilePattern(routePath: string): PatternMatcher {
  const parts = routePath.split("/").filter(Boolean);
  const paramNames: string[] = [];

  const regexParts = parts.map((part) => {
    if (part.startsWith(":")) {
      paramNames.push(part.slice(1));
      return "([^/]+)";
    }
    return escapeRegex(part);
  });

  const regex = new RegExp(`^/${regexParts.join("/")}$`);

  return (pathname: string) => {
    const match = pathname.match(regex);
    if (!match) return null;

    const params: Record<string, string> = {};
    paramNames.forEach((name, i) => {
      params[name] = match[i + 1]!;
    });
    return params;
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Route execution
// ---------------------------------------------------------------------------

async function executeRoute(
  koaCtx: KoaContext,
  entry: RouteEntry & { pattern: PatternMatcher },
  params: Record<string, string>,
  validateResponses: boolean,
  globalMiddleware: MiddlewareDefinition<any>[],
) {
  const { route, middleware: directoryMiddleware } = entry;

  const routeCtx = new KoaRouteContext(koaCtx);
  setRouteCtx(koaCtx, routeCtx);

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

  const terminalHandler = createTerminalHandler(koaCtx, route, params, entry.path, validateResponses);

  try {
    const result = await compose(chain, terminalHandler)(routeCtx);

    if (result instanceof Response) {
      koaCtx.status = result.status;
      const ct = result.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        koaCtx.body = await result.json();
      } else {
        koaCtx.body = await result.text();
      }
    } else {
      koaCtx.status = 200;
      koaCtx.body = result;
    }
  } catch (err) {
    if (err instanceof RouteError) {
      koaCtx.status = err.status;
      koaCtx.body = { error: err.message, ...(err.data ? { data: err.data } : {}) };
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

type RoutedMiddleware = (
  ctx: KoaRouteContext,
  next: () => Promise<unknown>,
) => unknown | Promise<unknown>;

function toRoutedMiddleware(mw: MiddlewareDefinition): RoutedMiddleware {
  return async (ctx, next) => {
    return mw.handler({ ctx, next });
  };
}

function compose(
  middlewares: RoutedMiddleware[],
  handler: (ctx: KoaRouteContext) => unknown | Promise<unknown>,
): (ctx: KoaRouteContext) => Promise<unknown> {
  return async (ctx: KoaRouteContext) => {
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

function createTerminalHandler(
  koaCtx: KoaContext,
  route: RouteDefinition<RouteSchemas>,
  rawParams: Record<string, string>,
  routePath: string,
  validateResponses: boolean,
): (ctx: KoaRouteContext) => Promise<unknown> {
  return async (ctx) => {
    const { schemas } = route;

    // Validate params
    let params: unknown;
    if (schemas.params) {
      const result = await validateSchema(schemas.params, rawParams);
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
      const rawBody = await readJsonBody(koaCtx);
      const result = await validateSchema(schemas.body, rawBody);
      if (!result.success) {
        return validationErrorResponse("body", result.issues);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonBody(ctx: KoaContext): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    ctx.req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    ctx.req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch {
        resolve(null);
      }
    });
    ctx.req.on("error", reject);
  });
}
