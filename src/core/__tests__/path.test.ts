import { describe, expect, test } from "bun:test";
import { compareRoutePathSpecificity, getPathname, matchRoutePath } from "../path.ts";

describe("path helpers", () => {
  test("getPathname preserves encoded path segments", () => {
    expect(getPathname("/storage/a%2Fb/c%20d?x=1")).toBe("/storage/a%2Fb/c%20d");
  });

  test("matchRoutePath decodes single-segment params", () => {
    expect(matchRoutePath("/users/:userId", "/users/a%20b")).toEqual({
      userId: "a b",
    });
  });

  test("matchRoutePath decodes splat segments one segment at a time", () => {
    expect(matchRoutePath("/storage/:path*", "/storage/a%2Fb/c%20d")).toEqual({
      path: ["a/b", "c d"],
    });
  });

  test("compareRoutePathSpecificity ranks static segments before params and params before splats", () => {
    const paths = [
      "/workspaces/:id",
      "/workspaces/activity",
      "/workspaces/:path*",
      "/workspaces",
    ];

    expect(paths.sort(compareRoutePathSpecificity)).toEqual([
      "/workspaces/activity",
      "/workspaces/:id",
      "/workspaces/:path*",
      "/workspaces",
    ]);
  });

  test("compareRoutePathSpecificity totally orders equally specific paths", () => {
    // Same-length static segments and differing param names used to compare
    // as equal, leaving the order up to file-system scan order.
    expect(compareRoutePathSpecificity("/users/:id", "/teams/:id")).toBeGreaterThan(0);
    expect(compareRoutePathSpecificity("/teams/:id", "/users/:id")).toBeLessThan(0);
    expect(compareRoutePathSpecificity("/users/:id", "/users/:name")).toBeLessThan(0);
    expect(compareRoutePathSpecificity("/users/:id", "/users/:id")).toBe(0);

    const shuffled = ["/users/:id", "/posts/:id", "/teams/:id", "/roles/:id"];
    const reversed = [...shuffled].reverse();
    expect([...shuffled].sort(compareRoutePathSpecificity)).toEqual(
      [...reversed].sort(compareRoutePathSpecificity),
    );
  });
});
