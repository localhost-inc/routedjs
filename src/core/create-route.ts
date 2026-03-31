import type {
  HandlerFn,
  MergeMiddlewareState,
  MiddlewareDefinition,
  MiddlewareFn,
  RouteDefinition,
  RouteMeta,
  RouteSchemas,
} from "./types.ts";

function normalizeMiddleware(
  input: MiddlewareDefinition<any> | MiddlewareFn,
): MiddlewareDefinition<any> {
  if (typeof input === "function") {
    return { __brand: "routed:middleware", handler: input as MiddlewareFn<Record<string, unknown>> };
  }
  return input;
}

// Overload 1: with typed middleware → state flows into handler
export function createRoute<
  TSchemas extends RouteSchemas,
  const TMiddleware extends readonly MiddlewareDefinition<any>[],
>(options: {
  schemas?: TSchemas;
  meta?: RouteMeta;
  middleware: [...TMiddleware];
  handler: NoInfer<HandlerFn<TSchemas, MergeMiddlewareState<TMiddleware>>>;
}): RouteDefinition<TSchemas>;

// Overload 2: no middleware or inline functions
export function createRoute<TSchemas extends RouteSchemas = RouteSchemas>(options: {
  schemas?: TSchemas;
  meta?: RouteMeta;
  middleware?: (MiddlewareDefinition<any> | MiddlewareFn)[];
  handler: HandlerFn<TSchemas>;
}): RouteDefinition<TSchemas>;

// Implementation
export function createRoute(
  options: {
    schemas?: RouteSchemas;
    meta?: RouteMeta;
    middleware?: (MiddlewareDefinition<any> | MiddlewareFn)[];
    handler: HandlerFn<any, any>;
  },
): RouteDefinition {
  return {
    __brand: "routed:route",
    schemas: (options.schemas ?? {}) as RouteSchemas,
    meta: options.meta,
    middleware: options.middleware?.map(normalizeMiddleware) ?? [],
    handler: options.handler,
  };
}
