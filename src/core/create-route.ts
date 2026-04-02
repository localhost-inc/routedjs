import type {
  HandlerInput,
  MergeMiddlewareState,
  MiddlewareDefinition,
  MiddlewareFn,
  RouteDefinition,
  RouteMeta,
  RouteSchemas,
  ValidMiddlewareChain,
} from "./types.ts";

function normalizeMiddleware(
  input: MiddlewareDefinition<any, any> | MiddlewareFn,
): MiddlewareDefinition<any, any> {
  if (typeof input === "function") {
    return {
      __brand: "routed:middleware",
      handler: input as MiddlewareFn<
        Record<string, unknown>,
        Record<string, unknown>
      >,
    };
  }
  return input;
}

// Overload 1: with typed middleware → state flows into handler
export function createRoute<
  TSchemas extends RouteSchemas,
  const TMiddleware extends readonly MiddlewareDefinition<any, any>[],
  TReturn,
>(options: {
  schemas?: TSchemas;
  meta?: RouteMeta;
  middleware: [...TMiddleware] & ValidMiddlewareChain<TMiddleware>;
  handler: (input: HandlerInput<TSchemas, MergeMiddlewareState<TMiddleware>>) => TReturn;
}): RouteDefinition<
  TSchemas,
  (input: HandlerInput<TSchemas, MergeMiddlewareState<TMiddleware>>) => TReturn
>;

// Overload 2: no middleware or inline-only middleware
export function createRoute<
  TSchemas extends RouteSchemas = {},
  TReturn = unknown,
>(options: {
  schemas?: TSchemas;
  meta?: RouteMeta;
  middleware?: MiddlewareFn[];
  handler: (input: HandlerInput<TSchemas>) => TReturn;
}): RouteDefinition<TSchemas, (input: HandlerInput<TSchemas>) => TReturn>;

// Implementation
export function createRoute(
  options: {
    schemas?: RouteSchemas;
    meta?: RouteMeta;
    middleware?: (MiddlewareDefinition<any, any> | MiddlewareFn)[];
    handler: (input: HandlerInput<any, any>) => unknown | Promise<unknown>;
  },
): RouteDefinition<
  RouteSchemas,
  (input: HandlerInput<any, any>) => unknown | Promise<unknown>
> {
  return {
    __brand: "routed:route",
    schemas: (options.schemas ?? {}) as RouteSchemas,
    meta: options.meta,
    middleware: options.middleware?.map(normalizeMiddleware) ?? [],
    handler: options.handler,
  };
}
