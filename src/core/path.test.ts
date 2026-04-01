import { describe, expect, test } from "bun:test";
import { getPathname, matchRoutePath } from "./path.ts";

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
});
