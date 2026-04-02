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

type MiddlewareContext<
  TProvides extends Record<string, unknown>,
  TRequires extends Record<string, unknown>,
> = MaybeTypedRouteContext<TRequires> & {
    set<K extends string & keyof TProvides>(key: K, value: TProvides[K]): void;
  };

export type MiddlewareFn<
  TProvides extends Record<string, unknown> = EmptyState,
  TRequires extends Record<string, unknown> = EmptyState,
> = (input: {
  ctx: MiddlewareContext<TProvides, TRequires>;
  next: () => Promise<unknown>;
}) => unknown | Promise<unknown>;

/** Phantom types carry the middleware contract for inference. Never set at runtime. */
export type MiddlewareDefinition<
  TProvides extends Record<string, unknown> = EmptyState,
  TRequires extends Record<string, unknown> = EmptyState,
> = {
  __brand: "routed:middleware";
  handler: MiddlewareFn<Record<string, unknown>, Record<string, unknown>>;
  /** @internal Phantom — do not access. */
  readonly _provides?: TProvides;
  /** @internal Phantom — do not access. */
  readonly _requires?: TRequires;
};

// ---------------------------------------------------------------------------
// State inference helpers
// ---------------------------------------------------------------------------

type ExtractProvidedState<T> = T extends MiddlewareDefinition<infer S, any>
  ? S
  : EmptyState;

type ExtractRequiredState<T> = T extends MiddlewareDefinition<any, infer S>
  ? S
  : EmptyState;

type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;

export type MergeMiddlewareState<T extends readonly unknown[]> = UnionToIntersection<
  ExtractProvidedState<T[number]>
> extends infer R extends Record<string, unknown> ? R : EmptyState;

type ValidateMiddlewareChain<
  TMiddleware extends readonly MiddlewareDefinition<any, any>[],
  TAvailable extends Record<string, unknown> = EmptyState,
> = TMiddleware extends readonly [
  infer Head extends MiddlewareDefinition<any, any>,
  ...infer Tail extends readonly MiddlewareDefinition<any, any>[],
]
  ? AvailableState<TAvailable> extends ExtractRequiredState<Head>
    ? readonly [
        Head,
        ...ValidateMiddlewareChain<
          Tail,
          TAvailable & ExtractProvidedState<Head>
        >,
      ]
    : never
  : TMiddleware;

export type ValidMiddlewareChain<
  TMiddleware extends readonly MiddlewareDefinition<any, any>[],
> = ValidateMiddlewareChain<TMiddleware>;

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

export type InferSchemaOutput<T> = T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : never;

export type InferResponsesOutput<T extends ResponseSchemaMap | undefined> = T extends ResponseSchemaMap
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

export type HandlerReturn<TSchemas extends RouteSchemas> =
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

export type RouteDefinition<
  TSchemas extends RouteSchemas = RouteSchemas,
  THandler extends (input: any) => unknown | Promise<unknown> = HandlerFn<TSchemas>,
> = {
  __brand: "routed:route";
  schemas: TSchemas;
  meta?: RouteMeta;
  middleware: MiddlewareDefinition<any, any>[];
  handler: THandler;
};

// ---------------------------------------------------------------------------
// Route tree entry (what the generated manifest contains)
// ---------------------------------------------------------------------------

export type RouteEntry = {
  path: string;
  method: HttpMethod;
  route: RouteDefinition<any>;
  /** Directory middleware, ordered root → leaf. */
  middleware: MiddlewareDefinition<any, any>[];
};

export type RouteTree = RouteEntry[];
