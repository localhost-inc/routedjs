type RouteParamValue = string | string[];

const PARAM_SEGMENT = /^:(\w+)$/;
const SPLAT_SEGMENT = /^:(\w+)\*$/;
const ROUTED_URL_BASE = "http://routed.local";

function splitRoutePath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function getSegmentRank(segment: string): number {
  if (SPLAT_SEGMENT.test(segment)) return 0;
  if (PARAM_SEGMENT.test(segment)) return 1;
  return 2;
}

export function getPathname(urlOrPath: string): string {
  return new URL(urlOrPath, ROUTED_URL_BASE).pathname;
}

export function hasSplatParam(path: string): boolean {
  return splitRoutePath(path).some((segment) => SPLAT_SEGMENT.test(segment));
}

export function extractSplatParamNames(path: string): string[] {
  return splitRoutePath(path).flatMap((segment) => {
    const splatMatch = segment.match(SPLAT_SEGMENT);
    return splatMatch ? [splatMatch[1]!] : [];
  });
}

export function extractParamNames(path: string): string[] {
  return splitRoutePath(path).flatMap((segment) => {
    const splatMatch = segment.match(SPLAT_SEGMENT);
    if (splatMatch) return [splatMatch[1]!];

    const paramMatch = segment.match(PARAM_SEGMENT);
    return paramMatch ? [paramMatch[1]!] : [];
  });
}

export function toOpenAPIPath(path: string): string {
  return splitRoutePath(path)
    .map((segment) => {
      const splatMatch = segment.match(SPLAT_SEGMENT);
      if (splatMatch) return `{${splatMatch[1]!}}`;

      const paramMatch = segment.match(PARAM_SEGMENT);
      if (paramMatch) return `{${paramMatch[1]!}}`;

      return segment;
    })
    .reduce((acc, segment) => acc + "/" + segment, "") || "/";
}

export function matchRoutePath(
  routePath: string,
  pathname: string,
): Record<string, RouteParamValue> | null {
  const routeSegments = splitRoutePath(routePath);
  const pathSegments = splitRoutePath(pathname);

  if (routeSegments.length === 0) {
    return pathSegments.length === 0 ? {} : null;
  }

  const params: Record<string, RouteParamValue> = {};
  let pathIndex = 0;

  for (let routeIndex = 0; routeIndex < routeSegments.length; routeIndex += 1) {
    const routeSegment = routeSegments[routeIndex]!;
    const splatMatch = routeSegment.match(SPLAT_SEGMENT);
    if (splatMatch) {
      const remainder = pathSegments.slice(pathIndex);
      if (remainder.length === 0) return null;
      params[splatMatch[1]!] = remainder.map(decodePathSegment);
      return params;
    }

    const currentPathSegment = pathSegments[pathIndex];
    if (currentPathSegment === undefined) return null;
    const decodedPathSegment = decodePathSegment(currentPathSegment);

    const paramMatch = routeSegment.match(PARAM_SEGMENT);
    if (paramMatch) {
      params[paramMatch[1]!] = decodedPathSegment;
      pathIndex += 1;
      continue;
    }

    if (routeSegment !== decodedPathSegment) {
      return null;
    }

    pathIndex += 1;
  }

  return pathIndex === pathSegments.length ? params : null;
}

export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Total order: returns 0 only for identical paths. Equally specific paths
 * fall back to code-point order so generated output is byte-stable across
 * file systems and locales.
 */
export function compareRoutePathSpecificity(a: string, b: string): number {
  const aSegments = splitRoutePath(a);
  const bSegments = splitRoutePath(b);
  const maxLength = Math.max(aSegments.length, bSegments.length);

  for (let index = 0; index < maxLength; index += 1) {
    const aSegment = aSegments[index];
    const bSegment = bSegments[index];

    if (aSegment === undefined) return 1;
    if (bSegment === undefined) return -1;

    const rankDiff = getSegmentRank(bSegment) - getSegmentRank(aSegment);
    if (rankDiff !== 0) return rankDiff;

    if (aSegment !== bSegment) {
      if (getSegmentRank(aSegment) === 2) {
        const lengthDiff = bSegment.length - aSegment.length;
        if (lengthDiff !== 0) return lengthDiff;
      }
      return compareCodePoints(aSegment, bSegment);
    }
  }

  return 0;
}
