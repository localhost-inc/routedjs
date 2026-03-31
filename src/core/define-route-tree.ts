import type { RouteTree } from "./types.ts";

/**
 * Identity function used in the generated manifest for type inference.
 */
export function defineRouteTree(routes: RouteTree): RouteTree {
  return routes;
}
