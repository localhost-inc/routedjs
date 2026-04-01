import type { Register } from "../index.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RouteContext } from "./context.ts";

type EmptyState = Record<never, never>;

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
  responses?: ResponseSchemaMap;
};

export type ResponseStatus = number | `${number}`;

export type ResponseSchemaMap = Partial<Record<ResponseStatus, StandardSchemaV1>>;

export type RegisteredAppContext =
  Register extends { appContext: infer T extends Record<string, unknown> }
    ? T
    : EmptyState;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

type AvailableState<TState extends Record<string, unknown>> =
  RegisteredAppContext & TState;

type MaybeTypedRouteContext<TState extends Record<string, unknown>> =
  [keyof AvailableState<TState>] extends [never]
    ? RouteContext
    : TypedRouteContext<TState>;

type MiddlewareContext<TState extends Record<string, unknown>> =
  MaybeTypedRouteContext<EmptyState> & {
    set<K extends string & keyof TState>(key: K, value: TState[K]): void;
  };

export type MiddlewareFn<
  TState extends Record<string, unknown> = Record<string, unknown>,
> = (input: {
  ctx: MiddlewareContext<TState>;
  next: () => Promise<unknown>;
}) => unknown | Promise<unknown>;

/** Phantom type `_state` carries the state shape for inference. Never set at runtime. */
export type MiddlewareDefinition<
  TState extends Record<string, unknown> = EmptyState,
> = {
  __brand: "routed:middleware";
  handler: MiddlewareFn<Record<string, unknown>>;
  /** @internal Phantom — do not access. */
  readonly _state?: TState;
};

// ---------------------------------------------------------------------------
// State inference helpers
// ---------------------------------------------------------------------------

type ExtractState<T> = T extends MiddlewareDefinition<infer S> ? S : EmptyState;

type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;

export type MergeMiddlewareState<T extends readonly unknown[]> = UnionToIntersection<
  ExtractState<T[number]>
> extends infer R extends Record<string, unknown> ? R : EmptyState;

// ---------------------------------------------------------------------------
// Typed context — RouteContext with typed get() from middleware state
// ---------------------------------------------------------------------------

export type TypedRouteContext<
  TState extends Record<string, unknown> = EmptyState,
> =
  Omit<RouteContext, "get"> & {
    get<K extends string & keyof AvailableState<TState>>(
      key: K,
    ): AvailableState<TState>[K];
    get(key: string): unknown;
  };

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

type InferOptional<T extends StandardSchemaV1 | undefined> = T extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<T>
  : undefined;

type InferSchemaOutput<T> = T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : never;

type InferResponsesOutput<T extends ResponseSchemaMap | undefined> = T extends ResponseSchemaMap
  ? InferSchemaOutput<T[keyof T]>
  : never;

export type HandlerInput<
  TSchemas extends RouteSchemas,
  TState extends Record<string, unknown> = EmptyState,
> = {
  params: InferOptional<TSchemas["params"]>;
  query: InferOptional<TSchemas["query"]>;
  body: InferOptional<TSchemas["body"]>;
  ctx: MaybeTypedRouteContext<TState>;
};

type HandlerReturn<TSchemas extends RouteSchemas> =
  TSchemas["responses"] extends ResponseSchemaMap
    ? InferResponsesOutput<TSchemas["responses"]> | Response
    : TSchemas["response"] extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<TSchemas["response"]> | Response
    : unknown;

export type HandlerFn<
  TSchemas extends RouteSchemas,
  TState extends Record<string, unknown> = EmptyState,
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
  handler: (input: any) => unknown | Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Route tree entry (what the generated manifest contains)
// ---------------------------------------------------------------------------

export type RouteEntry = {
  path: string;
  method: HttpMethod;
  route: RouteDefinition<any>;
  /** Directory middleware, ordered root → leaf. */
  middleware: MiddlewareDefinition<any>[];
};

export type RouteTree = RouteEntry[];
