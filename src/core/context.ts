// ---------------------------------------------------------------------------
// RouteContext — universal request/response interface
// ---------------------------------------------------------------------------

export interface RouteContext {
  // --- Request (read-only) ---
  readonly request: Request;
  header(name: string): string | undefined;
  readonly method: string;
  readonly path: string;

  // --- Response ---
  status(code: number): void;
  setHeader(name: string, value: string): void;
  json(data: unknown, status?: number): Response;
  text(body: string, status?: number): Response;
  redirect(url: string, status?: number): Response;

  // --- State (middleware → handler) ---
  set(key: string, value: unknown): void;
  get(key: string): unknown;

  // --- Escape hatch ---
  readonly raw: unknown;
}

// ---------------------------------------------------------------------------
// BaseRouteContext — shared implementation for adapters to extend
// ---------------------------------------------------------------------------

export abstract class BaseRouteContext implements RouteContext {
  abstract readonly request: Request;
  abstract readonly method: string;
  abstract readonly path: string;
  abstract readonly raw: unknown;

  private _status = 200;
  private _headers = new Headers();
  private _state = new Map<string, unknown>();

  header(name: string): string | undefined {
    return this.request.headers.get(name) ?? undefined;
  }

  status(code: number): void {
    this._status = code;
  }

  setHeader(name: string, value: string): void {
    this._headers.set(name, value);
  }

  json(data: unknown, status?: number): Response {
    const headers = new Headers(this._headers);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(data), {
      status: status ?? this._status,
      headers,
    });
  }

  text(body: string, status?: number): Response {
    const headers = new Headers(this._headers);
    headers.set("content-type", "text/plain");
    return new Response(body, {
      status: status ?? this._status,
      headers,
    });
  }

  redirect(url: string, status = 302): Response {
    return new Response(null, {
      status,
      headers: { location: url },
    });
  }

  set(key: string, value: unknown): void {
    this._state.set(key, value);
  }

  get(key: string): unknown {
    if (!this._state.has(key)) {
      throw new Error(`Context key "${key}" has not been set`);
    }
    return this._state.get(key);
  }
}
