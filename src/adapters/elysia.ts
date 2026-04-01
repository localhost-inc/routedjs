import Elysia from "elysia";
import type { Context as ElysiaContext } from "elysia";
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
  readonly params: Record<string, unknown>;
  readonly raw: ElysiaContext;
  private readonly requestUrl: string;
  private readonly requestHeaders: Headers;
  private readonly requestBody: RequestBody | undefined;
  private requestCache?: Request;

  constructor(
    elysiaCtx: ElysiaContext,
    routePath: string,
    params?: Record<string, unknown>,
  ) {
    super();
    this.method = elysiaCtx.request.method;
    this.path = getPathname(elysiaCtx.request.url);
    this.params = params ?? matchRoutePath(routePath, this.path) ?? (elysiaCtx.params as Record<string, unknown>);
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
  middleware?: MiddlewareDefinition<any, any>[];
};

/**
 * Create an Elysia app from a routed route tree.
 */
export function createElysiaApp(routeTree: RouteTree, options?: CreateElysiaAppOptions): Elysia {
  let app = new Elysia();
  const validateResponses = options?.validateResponses ?? false;
  const globalMiddleware = options?.middleware ?? [];

  const preparedRoutes = routeTree.map((entry) =>
    prepareRoute(entry, validateResponses, globalMiddleware),
  ).sort((a, b) => compareRoutePathSpecificity(a.path, b.path));

  for (const entry of preparedRoutes) {
    app = registerRoute(app, entry);
  }

  return app;
}

type PreparedRoute = RouteEntry & {
  execute: (ctx: ElysiaRouteContext) => Promise<unknown>;
};

function prepareRoute(
  entry: RouteEntry,
  validateResponses: boolean,
  globalMiddleware: MiddlewareDefinition<any, any>[],
): PreparedRoute {
  const { path: routePath, route, middleware: directoryMiddleware } = entry;

  const chain: RoutedMiddleware<ElysiaRouteContext>[] = [
    ...globalMiddleware,
    ...directoryMiddleware,
    ...route.middleware,
  ].map(toRoutedMiddleware);
  const execute = composeRouteHandler(
    chain,
    async (ctx) => runHandler(route, ctx, routePath, validateResponses),
  );

  return { ...entry, execute };
}

function registerRoute(
  app: Elysia,
  entry: PreparedRoute,
): Elysia {
  const { path: routePath, method } = entry;
  const adapterRoutePath = translateRoutePathForElysia(routePath);

  const handler = async (elysiaCtx: ElysiaContext) => {
    return executePreparedRoute(entry, elysiaCtx, routePath);
  };

  const methodUpper = method.toUpperCase();
  return app.route(methodUpper, adapterRoutePath, handler as never) as unknown as Elysia;
}

function translateRoutePathForElysia(path: string): string {
  return path.replace(/:(\w+)\*/g, "*");
}

async function executePreparedRoute(
  route: PreparedRoute,
  elysiaCtx: ElysiaContext,
  routePath: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const ctx = new ElysiaRouteContext(elysiaCtx, routePath, params);

  try {
    const result = await route.execute(ctx);
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
    const result = await validateSchema(schemas.params, ctx.params);
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

  const responseSchema = validateResponses
    ? getResponseSchemaForStatus(schemas, ctx.getBufferedStatus())
    : undefined;

  if (responseSchema) {
    const validation = await validateSchema(responseSchema, handlerResult);
    if (!validation.success) {
      throw new RouteError(500, `Response validation failed for ${elysiaCtx.request.method} ${routePath}`, {
        issues: validation.issues,
      });
    }
  }

  return handlerResult;
}

/**
 * Wrap a routedjs route definition as an Elysia handler.
 * Used by the generated typed app.
 */
export function routeHandler(
  route: RouteDefinition<RouteSchemas>,
  routePath: string,
  options?: { validateResponses?: boolean },
) {
  const validateResponses = options?.validateResponses ?? false;
  const chain: RoutedMiddleware<ElysiaRouteContext>[] = [
    ...route.middleware,
  ].map(toRoutedMiddleware);
  const execute = composeRouteHandler(
    chain,
    async (ctx) => runHandler(route, ctx, routePath, validateResponses),
  );

  return async (elysiaCtx: ElysiaContext) => {
    const ctx = new ElysiaRouteContext(elysiaCtx, routePath);
    try {
      const result = await execute(ctx);
      return sendResult(elysiaCtx, ctx, result);
    } catch (err) {
      if (err instanceof RouteError) {
        elysiaCtx.set.status = err.status;
        return { error: err.message, ...(err.data ? { data: err.data } : {}) };
      }
      throw err;
    }
  };
}

/**
 * Wrap a routedjs middleware definition as Elysia middleware.
 * Used by the generated typed app.
 */
export function wrapMiddleware(mw: MiddlewareDefinition<any, any>) {
  return async (elysiaCtx: ElysiaContext) => {
    const ctx = new ElysiaRouteContext(elysiaCtx, "");
    let nextCalled = false;
    await mw.handler({
      ctx,
      next: async () => { nextCalled = true; },
    });
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
  const { routes, middlewares, outFile } = input;
  const outDir = path.dirname(outFile);
  const lines: string[] = [];

  lines.push("// ⚠️ Auto-generated by routed. Do not edit.");
  lines.push('import Elysia from "elysia";');
  lines.push('import { routeHandler } from "routedjs/elysia";');
  lines.push("");

  middlewares.forEach((mw, i) => {
    lines.push(`import middleware${i} from "${relImport(path, outDir, mw.filePath)}";`);
  });
  if (middlewares.length > 0) lines.push("");

  routes.forEach((route, i) => {
    lines.push(`import route${i} from "${relImport(path, outDir, route.filePath)}";`);
  });

  lines.push("");
  lines.push("export const app = new Elysia()");

  routes.forEach((route, i) => {
    const elysiaPath = route.urlPath.replace(/:(\w+)\*/g, "*");
    lines.push(`  .${route.method}("${elysiaPath}", routeHandler(route${i}, "${route.urlPath}") as any)`);
  });

  lines.push(";");
  lines.push("");
  lines.push("export type AppType = typeof app;");
  lines.push("");

  return lines.join("\n");
}

function relImport(p: typeof import("node:path"), fromDir: string, toFile: string): string {
  let rel = p.relative(fromDir, toFile);
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
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
