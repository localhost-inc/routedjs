import { describe, expect, test } from "bun:test";
import { filePathToUrlPath, parseMethod, resolveMiddlewareForRoute } from "./generate.ts";
import type { ScannedMiddleware } from "./generate.ts";

describe("parseMethod", () => {
  test("extracts method from route filename", () => {
    expect(parseMethod("index.get.route.ts")).toBe("get");
    expect(parseMethod("index.post.route.ts")).toBe("post");
    expect(parseMethod("$userId.put.route.ts")).toBe("put");
    expect(parseMethod("$userId.patch.route.tsx")).toBe("patch");
    expect(parseMethod("$userId.delete.route.ts")).toBe("delete");
  });

  test("returns null for invalid filenames", () => {
    expect(parseMethod("index.route.ts")).toBe(null);
    expect(parseMethod("route.ts")).toBe(null);
    expect(parseMethod("index.foo.route.ts")).toBe(null);
  });
});

describe("filePathToUrlPath", () => {
  test("root index", () => {
    expect(filePathToUrlPath("index.get.route.ts")).toBe("/");
  });

  test("simple path", () => {
    expect(filePathToUrlPath("users/index.get.route.ts")).toBe("/users");
  });

  test("named file in directory", () => {
    expect(filePathToUrlPath("users/search.get.route.ts")).toBe("/users/search");
  });

  test("dynamic param in directory", () => {
    expect(filePathToUrlPath("users/$userId/index.get.route.ts")).toBe("/users/:userId");
  });

  test("dynamic param as filename", () => {
    expect(filePathToUrlPath("users/$userId.get.route.ts")).toBe("/users/:userId");
  });

  test("catch-all param as filename", () => {
    expect(filePathToUrlPath("storage/$$path.get.route.ts")).toBe("/storage/:path*");
  });

  test("catch-all param as directory", () => {
    expect(filePathToUrlPath("storage/$$path/index.get.route.ts")).toBe("/storage/:path*");
  });

  test("nested dynamic params", () => {
    expect(filePathToUrlPath("users/$userId/visits.get.route.ts")).toBe(
      "/users/:userId/visits",
    );
  });

  test("deeply nested", () => {
    expect(
      filePathToUrlPath("users/$userId/visits/$visitId.get.route.ts"),
    ).toBe("/users/:userId/visits/:visitId");
  });

  test("pathless group (_prefix) is stripped", () => {
    expect(filePathToUrlPath("_admin/users.get.route.ts")).toBe("/users");
  });

  test("pathless group nested", () => {
    expect(filePathToUrlPath("_auth/login.post.route.ts")).toBe("/login");
  });

  test("catch-all params must be terminal", () => {
    expect(() => filePathToUrlPath("storage/$$path/meta.get.route.ts")).toThrow(
      "Catch-all segment must be the final route segment",
    );
  });
});

describe("resolveMiddlewareForRoute", () => {
  const middlewares: ScannedMiddleware[] = [
    { filePath: "/routes/_middleware.ts", directory: "." },
    { filePath: "/routes/users/_middleware.ts", directory: "users" },
    { filePath: "/routes/users/admin/_middleware.ts", directory: "users/admin" },
  ];

  test("root route gets root middleware only", () => {
    const result = resolveMiddlewareForRoute(".", middlewares);
    expect(result).toHaveLength(1);
    expect(result[0]!.directory).toBe(".");
  });

  test("users route gets root + users middleware", () => {
    const result = resolveMiddlewareForRoute("users", middlewares);
    expect(result).toHaveLength(2);
    expect(result[0]!.directory).toBe(".");
    expect(result[1]!.directory).toBe("users");
  });

  test("nested users route gets root + users middleware", () => {
    const result = resolveMiddlewareForRoute("users/$userId", middlewares);
    expect(result).toHaveLength(2);
  });

  test("admin route gets all three", () => {
    const result = resolveMiddlewareForRoute("users/admin", middlewares);
    expect(result).toHaveLength(3);
  });
});
