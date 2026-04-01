import type { MiddlewareDefinition, MiddlewareFn } from "./types.ts";

export function createMiddleware<
  TProvides extends Record<string, unknown> = Record<never, never>,
  TRequires extends Record<string, unknown> = Record<never, never>,
>(
  handler: MiddlewareFn<TProvides, TRequires>,
): MiddlewareDefinition<TProvides, TRequires> {
  return {
    __brand: "routed:middleware",
    handler: handler as MiddlewareFn<
      Record<string, unknown>,
      Record<string, unknown>
    >,
  };
}
