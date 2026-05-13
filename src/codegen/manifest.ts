import path from "node:path";

export type CodegenRoute = {
  filePath: string;
  urlPath: string;
  method: string;
};

export type CodegenMiddleware = {
  filePath: string;
  directory: string;
};

export function resolveMiddlewareForRoute(
  routeRelativeDir: string,
  middlewares: CodegenMiddleware[],
): CodegenMiddleware[] {
  return middlewares.filter((mw) => {
    if (mw.directory === ".") return true;
    return (
      routeRelativeDir === mw.directory ||
      routeRelativeDir.startsWith(mw.directory + path.sep)
    );
  });
}

export function toRelativeImport(fromDir: string, toFile: string): string {
  let rel = path.relative(fromDir, toFile);
  if (!rel.startsWith(".")) {
    rel = "./" + rel;
  }
  return rel;
}

export function createRouteImportNameMap(
  routes: CodegenRoute[],
  routesDir: string,
): Map<string, string> {
  return createImportNameMap(
    routes,
    routeBaseImportName,
    (route) => routeFileImportNameSuffix(route, routesDir),
  );
}

export function createMiddlewareImportNameMap(
  middlewares: CodegenMiddleware[],
  routesDir: string,
): Map<string, string> {
  return createImportNameMap(
    middlewares,
    middlewareBaseImportName,
    (middleware) => middlewareFileImportNameSuffix(middleware, routesDir),
  );
}

function createImportNameMap<T extends { filePath: string }>(
  items: T[],
  getBaseName: (item: T) => string,
  getFallbackSuffix: (item: T) => string,
): Map<string, string> {
  const entries = items.map((item) => ({
    item,
    baseName: getBaseName(item),
    fallbackSuffix: getFallbackSuffix(item),
  }));
  const baseNameCounts = new Map<string, number>();

  for (const entry of entries) {
    baseNameCounts.set(
      entry.baseName,
      (baseNameCounts.get(entry.baseName) ?? 0) + 1,
    );
  }

  const usedNames = new Map<string, number>();
  const names = new Map<string, string>();

  for (const entry of entries) {
    const collides = (baseNameCounts.get(entry.baseName) ?? 0) > 1;
    const candidate = collides
      ? `${entry.baseName}From${entry.fallbackSuffix}`
      : entry.baseName;
    names.set(entry.item.filePath, uniqueImportName(candidate, usedNames));
  }

  return names;
}

function uniqueImportName(name: string, usedNames: Map<string, number>): string {
  const count = usedNames.get(name) ?? 0;
  usedNames.set(name, count + 1);
  return count === 0 ? name : `${name}${count + 1}`;
}

function routeBaseImportName(route: CodegenRoute): string {
  const pathParts =
    route.urlPath === "/"
      ? ["root"]
      : route.urlPath.split("/").filter(Boolean).flatMap(routeSegmentNameParts);
  return toImportName("route", [...pathParts, route.method]);
}

function routeSegmentNameParts(segment: string): string[] {
  if (!segment.startsWith(":")) return [segment];
  const isCatchAll = segment.endsWith("*");
  const paramName = segment.slice(1, isCatchAll ? -1 : undefined);
  return isCatchAll ? ["catchAll", paramName] : ["param", paramName];
}

function middlewareBaseImportName(middleware: CodegenMiddleware): string {
  if (middleware.directory === ".") return "middlewareRoot";
  return toImportName(
    "middleware",
    normalizeImportKey(middleware.directory)
      .split("/")
      .filter(Boolean)
      .flatMap(fileSystemSegmentNameParts),
  );
}

function routeFileImportNameSuffix(
  route: CodegenRoute,
  routesDir: string,
): string {
  const relativePath = normalizeImportKey(path.relative(routesDir, route.filePath))
    .replace(/\.route\.tsx?$/, "");
  return toPascalName(relativePath.split("/").flatMap(fileSystemSegmentNameParts));
}

function middlewareFileImportNameSuffix(
  middleware: CodegenMiddleware,
  routesDir: string,
): string {
  const relativePath = normalizeImportKey(path.relative(routesDir, middleware.filePath))
    .replace(/\/?_middleware\.tsx?$/, "");
  if (relativePath.length === 0) return "Root";
  return toPascalName(relativePath.split("/").flatMap(fileSystemSegmentNameParts));
}

function fileSystemSegmentNameParts(segment: string): string[] {
  if (segment.startsWith("$$")) {
    return ["catchAll", segment.slice(2)];
  }
  if (segment.startsWith("$")) {
    return ["param", segment.slice(1)];
  }
  if (segment.startsWith("_")) {
    return ["group", segment.slice(1)];
  }
  return segment.split(".");
}

function toImportName(prefix: string, parts: string[]): string {
  return `${prefix}${toPascalName(parts)}`;
}

function toPascalName(parts: string[]): string {
  const name = parts.flatMap(identifierWords).map(capitalize).join("");
  return name.length > 0 ? name : "Root";
}

function normalizeImportKey(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function identifierWords(value: string): string[] {
  return value.match(/[A-Za-z0-9]+/g) ?? [];
}

function capitalize(value: string): string {
  return value.length === 0 ? "" : value[0]!.toUpperCase() + value.slice(1);
}

export function generateManifestSource(
  routes: CodegenRoute[],
  middlewares: CodegenMiddleware[],
  outFile: string,
  routesDir: string,
  extraImports: string[] = [],
): string {
  const outDir = path.dirname(outFile);
  const lines: string[] = [];

  lines.push("// ⚠️ Auto-generated by routed. Do not edit.");
  lines.push('import { defineRouteTree } from "routedjs";');

  for (const extraImport of extraImports) {
    lines.push(extraImport);
  }

  if (extraImports.length > 0) {
    lines.push("");
  }

  const middlewareImportNames = createMiddlewareImportNameMap(middlewares, routesDir);
  middlewares.forEach((mw) => {
    const importName = middlewareImportNames.get(mw.filePath)!;
    lines.push(`import ${importName} from "${toRelativeImport(outDir, mw.filePath)}";`);
  });

  if (middlewares.length > 0) {
    lines.push("");
  }

  const routeImportNames = createRouteImportNameMap(routes, routesDir);
  routes.forEach((route) => {
    const importName = routeImportNames.get(route.filePath)!;
    lines.push(`import ${importName} from "${toRelativeImport(outDir, route.filePath)}";`);
  });

  lines.push("");
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
