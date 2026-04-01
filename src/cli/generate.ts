import path from "node:path";
import {
  generateManifestSource,
  resolveMiddlewareForRoute,
  type CodegenMiddleware,
  type CodegenRoute,
} from "../codegen/manifest.ts";
import { HTTP_METHODS, type HttpMethod } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScannedRoute = CodegenRoute & {
  /** Absolute path to the route file. */
  method: HttpMethod;
};

type ScannedMiddleware = CodegenMiddleware;
type InternalScannedMiddleware = {
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
  /** When set, outFile produces a typed framework app instead of a generic route tree. */
  framework?: string;
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

async function scanMiddleware(routesDir: string): Promise<InternalScannedMiddleware[]> {
  const glob = new Bun.Glob(MIDDLEWARE_PATTERN);
  const middlewares: InternalScannedMiddleware[] = [];

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
// Public API
// ---------------------------------------------------------------------------

export async function generate(options: GenerateOptions): Promise<{
  routeCount: number;
  middlewareCount: number;
}> {
  const { routesDir, outFile, clientOutFile, framework } = options;

  const [routes, middlewares] = await Promise.all([
    scanRoutes(routesDir),
    scanMiddleware(routesDir),
  ]);

  // When a framework is set, outFile produces a typed framework app.
  // Otherwise, produce the generic route tree.
  if (framework) {
    const codegen = await resolveFrameworkCodegen(framework);
    const content = await codegen({ routes, middlewares, outFile, routesDir });
    await Bun.write(outFile, content);
  } else {
    const content = generateManifestSource(routes, middlewares, outFile, routesDir);
    await Bun.write(outFile, content);
  }

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

type FrameworkCodegenInput = {
  routes: ScannedRoute[];
  middlewares: ScannedMiddleware[];
  outFile: string;
  routesDir: string;
};

type FrameworkCodegen = (input: FrameworkCodegenInput) => string | Promise<string>;

async function resolveFrameworkCodegen(framework: string): Promise<FrameworkCodegen> {
  switch (framework) {
    case "hono": {
      const mod = await import("../frameworks/hono.ts");
      return mod.generateTypedApp as FrameworkCodegen;
    }
    case "express": {
      const mod = await import("../frameworks/express.ts");
      return mod.generateTypedApp as FrameworkCodegen;
    }
    case "koa": {
      const mod = await import("../frameworks/koa.ts");
      return mod.generateTypedApp as FrameworkCodegen;
    }
    case "elysia": {
      const mod = await import("../frameworks/elysia.ts");
      return mod.generateTypedApp as FrameworkCodegen;
    }
    default:
      throw new Error(`Framework "${framework}" does not support typed app generation.`);
  }
}

// Export for testing
export { filePathToUrlPath, parseMethod, resolveMiddlewareForRoute };
export type { ScannedRoute, ScannedMiddleware };
