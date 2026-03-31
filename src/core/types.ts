import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RouteContext } from "./context.ts";

// ---------------------------------------------------------------------------
// HTTP methods
// ---------------------------------------------------------------------------

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export const HTTP_METHODS: readonly HttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
] as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export type RouteSchemas = {
  params?: StandardSchemaV1;
  query?: StandardSchemaV1;
  body?: StandardSchemaV1;
  response?: StandardSchemaV1;
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export type MiddlewareFn<TState extends Record<string, unknown> = Record<string, unknown>> = (input: {
  ctx: RouteContext & { set<K extends string & keyof TState>(key: K, value: TState[K]): void };
  next: () => Promise<unknown>;
}) => unknown | Promise<unknown>;

/** Phantom type `_state` carries the state shape for inference. Never set at runtime. */
export type MiddlewareDefinition<TState extends Record<string, unknown> = Record<string, never>> = {
  __brand: "routed:middleware";
  handler: MiddlewareFn<Record<string, unknown>>;
  /** @internal Phantom — do not access. */
  readonly _state?: TState;
};

// ---------------------------------------------------------------------------
// State inference helpers
// ---------------------------------------------------------------------------

type ExtractState<T> = T extends MiddlewareDefinition<infer S> ? S : Record<string, never>;

type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;

export type MergeMiddlewareState<T extends readonly unknown[]> = UnionToIntersection<
  ExtractState<T[number]>
> extends infer R extends Record<string, unknown> ? R : Record<string, never>;

// ---------------------------------------------------------------------------
// Typed context — RouteContext with typed get() from middleware state
// ---------------------------------------------------------------------------

export type TypedRouteContext<TState extends Record<string, unknown>> =
  Omit<RouteContext, "get"> & {
    get<K extends string & keyof TState>(key: K): TState[K];
    get(key: string): unknown;
  };

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

type InferOptional<T extends StandardSchemaV1 | undefined> = T extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<T>
  : undefined;

export type HandlerInput<
  TSchemas extends RouteSchemas,
  TState extends Record<string, unknown> = Record<string, never>,
> = {
  params: InferOptional<TSchemas["params"]>;
  query: InferOptional<TSchemas["query"]>;
  body: InferOptional<TSchemas["body"]>;
  ctx: [keyof TState] extends [never] ? RouteContext : TypedRouteContext<TState>;
};

type HandlerReturn<TSchemas extends RouteSchemas> =
  TSchemas["response"] extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<TSchemas["response"]> | Response
    : unknown;

export type HandlerFn<
  TSchemas extends RouteSchemas,
  TState extends Record<string, unknown> = Record<string, never>,
> = (
  input: HandlerInput<TSchemas, TState>,
) => HandlerReturn<TSchemas> | Promise<HandlerReturn<TSchemas>>;

// ---------------------------------------------------------------------------
// Route metadata (OpenAPI)
// ---------------------------------------------------------------------------

export type RouteMeta = {
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  deprecated?: boolean;
};

// ---------------------------------------------------------------------------
// Route definition (what createRoute returns)
// ---------------------------------------------------------------------------

export type RouteDefinition<TSchemas extends RouteSchemas = RouteSchemas> = {
  __brand: "routed:route";
  schemas: TSchemas;
  meta?: RouteMeta;
  middleware: MiddlewareDefinition<any>[];
  handler: HandlerFn<TSchemas, any>;
};

// ---------------------------------------------------------------------------
// Route tree entry (what the generated manifest contains)
// ---------------------------------------------------------------------------

export type RouteEntry = {
  path: string;
  method: HttpMethod;
  route: RouteDefinition;
  /** Directory middleware, ordered root → leaf. */
  middleware: MiddlewareDefinition<any>[];
};

export type RouteTree = RouteEntry[];
