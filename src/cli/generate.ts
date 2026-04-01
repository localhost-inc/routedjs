import path from "node:path";
import { HTTP_METHODS, type HttpMethod } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScannedRoute = {
  /** Absolute path to the route file. */
  filePath: string;
  /** Derived URL path, e.g. "/users/:userId". */
  urlPath: string;
  /** HTTP method derived from filename. */
  method: HttpMethod;
};

type ScannedMiddleware = {
  /** Absolute path to the _middleware.ts file. */
  filePath: string;
  /** Directory this middleware applies to (relative to routesDir). */
  directory: string;
};

type GenerateOptions = {
  /** Absolute path to the routes directory. */
  routesDir: string;
  /** Absolute path to the output file. */
  outFile: string;
  /** Absolute path to the client output file (optional). */
  clientOutFile?: string;
};

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

const ROUTE_PATTERN = `**/*.{${HTTP_METHODS.join(",")}}.route.{ts,tsx}`;
const MIDDLEWARE_PATTERN = "**/_middleware.{ts,tsx}";

function parseMethod(fileName: string): HttpMethod | null {
  // e.g. "index.get.route.ts" → "get"
  // e.g. "$userId.put.route.tsx" → "put"
  const parts = fileName.split(".");
  // Expected: [name, method, "route", ext]
  if (parts.length < 4) return null;
  const method = parts[parts.length - 3]!;
  return HTTP_METHODS.includes(method as HttpMethod)
    ? (method as HttpMethod)
    : null;
}

function filePathToUrlPath(relativePath: string): string {
  // e.g. "users/$userId/visits.get.route.ts" → "/users/:userId/visits"
  // e.g. "users/index.get.route.ts" → "/users"
  // e.g. "index.get.route.ts" → "/"

  const dir = path.dirname(relativePath);
  const fileName = path.basename(relativePath);

  // Extract the route segment name (everything before .method.route.ext)
  const parts = fileName.split(".");
  const segmentName = parts[0]!;

  // Build path segments from directory + filename
  const fileSystemSegments: string[] = [];

  if (dir !== ".") {
    for (const part of dir.split(path.sep)) {
      if (part.startsWith("_")) {
        // Pathless group — skip this segment
        continue;
      }
      fileSystemSegments.push(part);
    }
  }

  // "index" is stripped — it represents the directory root
  if (segmentName !== "index") {
    fileSystemSegments.push(segmentName);
  }

  assertCatchAllSegmentsAreTerminal(fileSystemSegments, relativePath);
  const segments = fileSystemSegments.map(convertSegment);

  return "/" + segments.join("/");
}

function convertSegment(segment: string): string {
  // $$path -> :path*
  if (segment.startsWith("$$")) {
    return ":" + segment.slice(2) + "*";
  }
  // $param → :param
  if (segment.startsWith("$")) {
    return ":" + segment.slice(1);
  }
  return segment;
}

function assertCatchAllSegmentsAreTerminal(
  segments: string[],
  relativePath: string,
): void {
  const catchAllIndex = segments.findIndex((segment) => segment.startsWith("$$"));
  if (catchAllIndex === -1) return;

  if (catchAllIndex !== segments.length - 1) {
    throw new Error(
      `Catch-all segment must be the final route segment: ${relativePath}`,
    );
  }
}

async function scanRoutes(routesDir: string): Promise<ScannedRoute[]> {
  const glob = new Bun.Glob(ROUTE_PATTERN);
  const routes: ScannedRoute[] = [];

  for await (const relativePath of glob.scan({ cwd: routesDir })) {
    const fileName = path.basename(relativePath);
    const method = parseMethod(fileName);
    if (!method) continue;

    routes.push({
      filePath: path.join(routesDir, relativePath),
      urlPath: filePathToUrlPath(relativePath),
      method,
    });
  }

  // Sort for deterministic output: by path, then method
  routes.sort((a, b) => a.urlPath.localeCompare(b.urlPath) || a.method.localeCompare(b.method));

  return routes;
}

async function scanMiddleware(routesDir: string): Promise<ScannedMiddleware[]> {
  const glob = new Bun.Glob(MIDDLEWARE_PATTERN);
  const middlewares: ScannedMiddleware[] = [];

  for await (const relativePath of glob.scan({ cwd: routesDir })) {
    const dir = path.dirname(relativePath);
    middlewares.push({
      filePath: path.join(routesDir, relativePath),
      directory: dir,
    });
  }

  // Sort by directory depth (root first) for deterministic ordering
  middlewares.sort((a, b) => {
    const depthA = a.directory === "." ? 0 : a.directory.split(path.sep).length;
    const depthB = b.directory === "." ? 0 : b.directory.split(path.sep).length;
    return depthA - depthB || a.directory.localeCompare(b.directory);
  });

  return middlewares;
}

// ---------------------------------------------------------------------------
// Middleware resolution
// ---------------------------------------------------------------------------

function resolveMiddlewareForRoute(
  routeRelativeDir: string,
  middlewares: ScannedMiddleware[],
): ScannedMiddleware[] {
  // A middleware applies to a route if the route's directory starts with
  // (or equals) the middleware's directory.
  // Root middleware (directory ".") applies to everything.
  return middlewares.filter((mw) => {
    if (mw.directory === ".") return true;
    // Route at "users/$userId" should match middleware at "users"
    return (
      routeRelativeDir === mw.directory ||
      routeRelativeDir.startsWith(mw.directory + path.sep)
    );
  });
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

function generateManifest(
  routes: ScannedRoute[],
  middlewares: ScannedMiddleware[],
  outFile: string,
  routesDir: string,
): string {
  const outDir = path.dirname(outFile);
  const lines: string[] = [];

  lines.push("// ⚠️ Auto-generated by routed. Do not edit.");
  lines.push('import { defineRouteTree } from "routedjs";');
  lines.push("");

  // Generate middleware imports
  const middlewareImportNames: Map<string, string> = new Map();
  middlewares.forEach((mw, i) => {
    const importName = `middleware${i}`;
    const importPath = toRelativeImport(outDir, mw.filePath);
    middlewareImportNames.set(mw.filePath, importName);
    lines.push(`import ${importName} from "${importPath}";`);
  });

  if (middlewares.length > 0) lines.push("");

  // Generate route imports
  const routeImportNames: Map<string, string> = new Map();
  routes.forEach((route, i) => {
    const importName = `route${i}`;
    const importPath = toRelativeImport(outDir, route.filePath);
    routeImportNames.set(route.filePath, importName);
    lines.push(`import ${importName} from "${importPath}";`);
  });

  lines.push("");

  // Generate route tree
  lines.push("export const routeTree = defineRouteTree([");

  for (const route of routes) {
    const routeName = routeImportNames.get(route.filePath)!;
    const routeRelativeDir = path.relative(routesDir, path.dirname(route.filePath));
    const applicableMiddleware = resolveMiddlewareForRoute(
      routeRelativeDir || ".",
      middlewares,
    );

    const middlewareArray = applicableMiddleware
      .map((mw) => middlewareImportNames.get(mw.filePath)!)
      .join(", ");

    lines.push("  {");
    lines.push(`    path: "${route.urlPath}",`);
    lines.push(`    method: "${route.method}",`);
    lines.push(`    route: ${routeName},`);
    lines.push(`    middleware: [${middlewareArray}],`);
    lines.push("  },");
  }

  lines.push("]);");
  lines.push("");

  return lines.join("\n");
}

function toRelativeImport(fromDir: string, toFile: string): string {
  let rel = path.relative(fromDir, toFile);
  // Ensure it starts with ./
  if (!rel.startsWith(".")) {
    rel = "./" + rel;
  }
  // Remove .ts/.tsx extension for import (bundlers handle this)
  // Actually, keep .ts for bun compatibility — strip only if needed
  return rel;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generate(options: GenerateOptions): Promise<{
  routeCount: number;
  middlewareCount: number;
}> {
  const { routesDir, outFile, clientOutFile } = options;

  const [routes, middlewares] = await Promise.all([
    scanRoutes(routesDir),
    scanMiddleware(routesDir),
  ]);

  const content = generateManifest(routes, middlewares, outFile, routesDir);
  await Bun.write(outFile, content);

  if (clientOutFile) {
    const { generateClientCode } = await import("../client/codegen.ts");
    const clientContent = generateClientCode({
      routes,
      outFile: clientOutFile,
      routesDir,
    });
    await Bun.write(clientOutFile, clientContent);
  }

  return {
    routeCount: routes.length,
    middlewareCount: middlewares.length,
  };
}

// Export for testing
export { filePathToUrlPath, parseMethod, resolveMiddlewareForRoute };
export type { ScannedRoute, ScannedMiddleware };
