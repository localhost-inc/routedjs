export type RoutedMiddleware<TContext> = (
  ctx: TContext,
  next: () => Promise<unknown>,
) => unknown | Promise<unknown>;

export function composeRouteHandler<TContext>(
  middlewares: RoutedMiddleware<TContext>[],
  terminal: (ctx: TContext) => Promise<unknown>,
): (ctx: TContext) => Promise<unknown> {
  if (middlewares.length === 0) {
    return terminal;
  }

  let handler = terminal;

  for (let index = middlewares.length - 1; index >= 0; index -= 1) {
    const middleware = middlewares[index]!;
    const nextHandler = handler;

    handler = async (ctx: TContext) => {
      let nextCalled = false;
      let downstreamResult: unknown;

      const result = await middleware(ctx, async () => {
        if (nextCalled) {
          throw new Error("next() called multiple times");
        }

        nextCalled = true;
        downstreamResult = await nextHandler(ctx);
        return downstreamResult;
      });

      return result !== undefined ? result : downstreamResult;
    };
  }

  return handler;
}
