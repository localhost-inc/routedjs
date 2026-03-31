// ---------------------------------------------------------------------------
// Type-safe API client for routed
// ---------------------------------------------------------------------------

export type ClientOptions = {
  baseUrl: string;
  headers?: Record<string, string> | (() => Record<string, string>);
  fetch?: typeof globalThis.fetch;
};

export type RequestOptions<
  TParams = undefined,
  TQuery = undefined,
  TBody = undefined,
> = (TParams extends undefined ? {} : { params: TParams }) &
  (TQuery extends undefined ? {} : { query: TQuery }) &
  (TBody extends undefined ? {} : { body: TBody }) & {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  };

export type ClientResponse<T> = {
  data: T;
  status: number;
  headers: Headers;
  response: Response;
};

export class ClientError extends Error {
  readonly status: number;
  readonly data: unknown;
  readonly response: Response;

  constructor(status: number, data: unknown, response: Response) {
    super(`Request failed with status ${status}`);
    this.name = "ClientError";
    this.status = status;
    this.data = data;
    this.response = response;
  }
}

// ---------------------------------------------------------------------------
// Route map types — used by generated code
// ---------------------------------------------------------------------------

/**
 * Describes a single endpoint's input/output types.
 * Generated code produces a map of these keyed by "METHOD /path".
 */
export type EndpointDef = {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  response?: unknown;
};

/**
 * A route map is a record from "METHOD /path" to endpoint definitions.
 * This is what the codegen produces as a type.
 */
export type RouteMap = Record<string, EndpointDef>;

// ---------------------------------------------------------------------------
// Client method types — derived from EndpointDef
// ---------------------------------------------------------------------------

type MethodFn<TDef extends EndpointDef> = (
  options: RequestOptions<TDef["params"], TDef["query"], TDef["body"]>,
) => Promise<ClientResponse<TDef["response"]>>;

type MethodFnNoArgs<TDef extends EndpointDef> = (
  options?: RequestOptions<TDef["params"], TDef["query"], TDef["body"]>,
) => Promise<ClientResponse<TDef["response"]>>;

type HasRequiredInput<TDef extends EndpointDef> =
  TDef["params"] extends undefined
    ? TDef["query"] extends undefined
      ? TDef["body"] extends undefined
        ? false
        : true
      : true
    : true;

type SmartMethodFn<TDef extends EndpointDef> =
  HasRequiredInput<TDef> extends true ? MethodFn<TDef> : MethodFnNoArgs<TDef>;

// ---------------------------------------------------------------------------
// Client type — maps route paths to method objects
// ---------------------------------------------------------------------------

// Extract all unique paths from a RouteMap
type ExtractPaths<TMap extends RouteMap> = {
  [K in keyof TMap]: K extends `${string} ${infer Path}` ? Path : never;
}[keyof TMap];

// Extract methods for a given path
type MethodsForPath<TMap extends RouteMap, TPath extends string> = {
  [K in keyof TMap as K extends `get ${TPath}`
    ? "get"
    : K extends `post ${TPath}`
      ? "post"
      : K extends `put ${TPath}`
        ? "put"
        : K extends `patch ${TPath}`
          ? "patch"
          : K extends `delete ${TPath}`
            ? "delete"
            : never]: K extends keyof TMap
    ? SmartMethodFn<TMap[K]>
    : never;
};

// Split a path into segments for nested access: "/users/:id" → ["users", ":id"]
type PathSegments<T extends string> = T extends `/${infer Rest}`
  ? PathSegments<Rest>
  : T extends `${infer Head}/${infer Tail}`
    ? [Head, ...PathSegments<Tail>]
    : T extends ""
      ? []
      : [T];

// Build nested object from path segments
type NestedClient<TMap extends RouteMap, TPath extends string, TSegments extends string[]> =
  TSegments extends [infer Head extends string, ...infer Tail extends string[]]
    ? { [K in Head]: NestedClient<TMap, TPath, Tail> }
    : MethodsForPath<TMap, TPath>;

// Merge all paths into a single nested object
type MergeClients<TMap extends RouteMap> = UnionToIntersection<
  {
    [P in ExtractPaths<TMap> & string]: NestedClient<TMap, P, PathSegments<P>>;
  }[ExtractPaths<TMap> & string]
>;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

export type Client<TMap extends RouteMap> = MergeClients<TMap> &
  MethodsForPath<TMap, "/">;

// ---------------------------------------------------------------------------
// Runtime implementation
// ---------------------------------------------------------------------------

export function createClient<TMap extends RouteMap>(
  options: ClientOptions,
): Client<TMap> {
  const { baseUrl, fetch: fetchFn = globalThis.fetch } = options;
  const base = baseUrl.replace(/\/$/, "");

  function getHeaders(): Record<string, string> {
    if (!options.headers) return {};
    return typeof options.headers === "function" ? options.headers() : options.headers;
  }

  // Build a fetch call from accumulated path segments and a method
  function makeRequest(pathSegments: string[], method: string) {
    return async (reqOptions?: RequestOptions<unknown, unknown, unknown>) => {
      // Build the URL path, substituting params
      let urlPath = "/" + pathSegments.join("/");
      const params = (reqOptions as Record<string, unknown>)?.params as
        | Record<string, string>
        | undefined;

      if (params) {
        for (const [key, value] of Object.entries(params)) {
          urlPath = urlPath.replace(`:${key}`, encodeURIComponent(value));
        }
      }

      // Build query string
      const query = (reqOptions as Record<string, unknown>)?.query as
        | Record<string, unknown>
        | undefined;
      let queryString = "";
      if (query) {
        const searchParams = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined && value !== null) {
            searchParams.set(key, String(value));
          }
        }
        const qs = searchParams.toString();
        if (qs) queryString = `?${qs}`;
      }

      const url = `${base}${urlPath}${queryString}`;

      // Build fetch options
      const init: RequestInit = {
        method: method.toUpperCase(),
        headers: {
          ...getHeaders(),
          ...(reqOptions?.headers ?? {}),
        },
        signal: reqOptions?.signal,
      };

      const body = (reqOptions as Record<string, unknown>)?.body;
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)["content-type"] = "application/json";
      }

      const response = await fetchFn(url, init);

      if (!response.ok) {
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          data = await response.text();
        }
        throw new ClientError(response.status, data, response);
      }

      const contentType = response.headers.get("content-type") ?? "";
      let data: unknown;
      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      return {
        data,
        status: response.status,
        headers: response.headers,
        response,
      };
    };
  }

  const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

  function buildProxy(segments: string[]): unknown {
    return new Proxy(() => {}, {
      get(_target, prop: string) {
        if (HTTP_METHODS.has(prop)) {
          return makeRequest(segments, prop);
        }
        return buildProxy([...segments, prop]);
      },
      apply(_target, _thisArg, args) {
        // Direct call — shouldn't happen in normal usage
        return undefined;
      },
    });
  }

  return buildProxy([]) as Client<TMap>;
}
