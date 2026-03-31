import Koa from "koa";
import type { Context as KoaContext } from "koa";
import { composeRouteHandler, type RoutedMiddleware } from "../core/compose.ts";
import { BaseRouteContext } from "../core/context.ts";
import { RouteError } from "../core/error.ts";
import { validateSchema } from "../core/validate.ts";
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
  readonly params: Record<string, string>;
  readonly raw: KoaContext;
  private requestState?: NodeRequestState;

  constructor(koaCtx: KoaContext, params: Record<string, string>) {
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
  middleware?: MiddlewareDefinition<any>[];
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
      pattern: compilePattern(entry.path),
      execute: composeRouteHandler(
        chain,
        createTerminalHandler(entry.route, entry.path, validateResponses),
      ),
    };
  });

  app.use(async (koaCtx, next) => {
    const method = koaCtx.method.toLowerCase();
    const pathname = koaCtx.path;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
