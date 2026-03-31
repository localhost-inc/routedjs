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
  private _headers?: Headers;
  private _headerCount = 0;
  private _state?: Map<string, unknown>;

  header(name: string): string | undefined {
    return this.request.headers.get(name) ?? undefined;
  }

  status(code: number): void {
    this._status = code;
  }

  setHeader(name: string, value: string): void {
    const headers = this.ensureHeaders();
    if (!headers.has(name)) {
      this._headerCount += 1;
    }
    headers.set(name, value);
  }

  json(data: unknown, status?: number): Response {
    return new Response(JSON.stringify(data), {
      status: status ?? this._status,
      headers: this.withHeaders("content-type", "application/json"),
    });
  }

  text(body: string, status?: number): Response {
    return new Response(body, {
      status: status ?? this._status,
      headers: this.withHeaders("content-type", "text/plain"),
    });
  }

  redirect(url: string, status?: number): Response {
    return new Response(null, {
      status: status ?? (this._status === 200 ? 302 : this._status),
      headers: this.withHeaders("location", url),
    });
  }

  set(key: string, value: unknown): void {
    (this._state ??= new Map<string, unknown>()).set(key, value);
  }

  get(key: string): unknown {
    if (!this._state?.has(key)) {
      throw new Error(`Context key "${key}" has not been set`);
    }
    return this._state.get(key);
  }

  /**
   * Convert a handler result into a Response while preserving buffered status and headers.
   */
  finalizeResult(result: unknown): Response {
    if (result instanceof Response) {
      return result;
    }
    if (result === undefined) {
      return new Response(null, {
        status: this._status,
        headers: this.cloneHeaders(),
      });
    }
    return this.json(result);
  }

  getBufferedStatus(): number {
    return this._status;
  }

  getBufferedHeaders(): Headers {
    return this.cloneHeaders();
  }

  hasBufferedHeaders(): boolean {
    return this._headerCount > 0;
  }

  hasBufferedResponseInit(): boolean {
    return this._status !== 200 || this._headerCount > 0;
  }

  forEachBufferedHeader(callback: (value: string, key: string) => void): void {
    this._headers?.forEach(callback);
  }

  private withHeaders(name: string, value: string): Headers {
    const headers = this.cloneHeaders();
    headers.set(name, value);
    return headers;
  }

  private cloneHeaders(): Headers {
    return this._headers ? new Headers(this._headers) : new Headers();
  }

  private ensureHeaders(): Headers {
    this._headers ??= new Headers();
    return this._headers;
  }
}
