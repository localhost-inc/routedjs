import type { MiddlewareDefinition, MiddlewareFn } from "./types.ts";

export function createMiddleware<
  TState extends Record<string, unknown> = Record<never, never>,
>(handler: MiddlewareFn<TState>): MiddlewareDefinition<TState> {
  return {
    __brand: "routed:middleware",
    handler: handler as MiddlewareFn<Record<string, unknown>>,
  };
}
