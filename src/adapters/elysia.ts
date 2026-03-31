import Elysia from "elysia";
import type { Context as ElysiaContext } from "elysia";
import { composeRouteHandler, type RoutedMiddleware } from "../core/compose.ts";
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
  readonly method: string;
  readonly path: string;
  readonly raw: ElysiaContext;
  private readonly requestUrl: string;
  private readonly requestHeaders: Headers;
  private readonly requestBody: RequestBody | undefined;
  private requestCache?: Request;

  constructor(elysiaCtx: ElysiaContext) {
    super();
    this.method = elysiaCtx.request.method;
    this.path = new URL(elysiaCtx.request.url).pathname;
    this.raw = elysiaCtx;
    this.requestUrl = elysiaCtx.request.url;
    this.requestHeaders = elysiaCtx.request.headers;
    this.requestBody = serializeBody(elysiaCtx.body);
  }

  get request(): Request {
    this.requestCache ??= createRequestSnapshot(
      this.requestUrl,
      this.method,
      this.requestHeaders,
      this.requestBody,
    );
    return this.requestCache;
  }

  override header(name: string): string | undefined {
    return this.requestHeaders.get(name) ?? undefined;
  }
}

type RequestBody = Exclude<RequestInit["body"], null | undefined>;

function createRequestSnapshot(
  url: string,
  method: string,
  headers: Headers,
  body: RequestBody | undefined,
): Request {
  if (body === undefined) {
    return new Request(url, { method, headers });
  }
  return new Request(url, { method, headers, body });
}

function serializeBody(body: unknown): RequestBody | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    body instanceof ReadableStream
  ) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return body as unknown as RequestBody;
  }
  return JSON.stringify(body);
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

  const chain: RoutedMiddleware<ElysiaRouteContext>[] = [
    ...globalMiddleware,
    ...directoryMiddleware,
    ...route.middleware,
  ].map(toRoutedMiddleware);
  const execute = composeRouteHandler(
    chain,
    async (ctx) => runHandler(route, ctx, routePath, validateResponses),
  );

  const handler = async (elysiaCtx: ElysiaContext) => {
    const ctx = new ElysiaRouteContext(elysiaCtx);

    try {
      const result = await execute(ctx);
      return sendResult(elysiaCtx, ctx, result);
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
// Middleware
// ---------------------------------------------------------------------------

function toRoutedMiddleware(
  middleware: MiddlewareDefinition,
): RoutedMiddleware<ElysiaRouteContext> {
  return async (ctx, next) => {
    return middleware.handler({ ctx, next });
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function runHandler(
  route: RouteDefinition<RouteSchemas>,
  ctx: ElysiaRouteContext,
  routePath: string,
  validateResponses: boolean,
): Promise<unknown> {
  const { schemas } = route;
  const elysiaCtx = ctx.raw;

  let params: unknown;
  if (schemas.params) {
    const result = await validateSchema(schemas.params, elysiaCtx.params);
    if (!result.success) {
      return ctx.json({ error: "Validation failed", target: "params", issues: result.issues }, 400);
    }
    params = result.data;
  }

  let query: unknown;
  if (schemas.query) {
    const result = await validateSchema(schemas.query, elysiaCtx.query);
    if (!result.success) {
      return ctx.json({ error: "Validation failed", target: "query", issues: result.issues }, 400);
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
      return ctx.json({ error: "Validation failed", target: "body", issues: result.issues }, 400);
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

function sendResult(
  elysiaCtx: ElysiaContext,
  ctx: ElysiaRouteContext,
  result: unknown,
): unknown {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined) {
    const headers = ctx.getBufferedHeaders();
    return new Response(null, {
      status: ctx.getBufferedStatus(),
      headers,
    });
  }

  if (ctx.hasBufferedResponseInit()) {
    elysiaCtx.set.status = ctx.getBufferedStatus();
    ctx.forEachBufferedHeader((value, key) => {
      elysiaCtx.set.headers[key] = value;
    });
  }

  return result;
}
