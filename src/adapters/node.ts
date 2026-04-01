import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

type StreamRequestInit = RequestInit & { duplex?: "half" };
type RequestBody = Exclude<RequestInit["body"], null | undefined>;
type HeaderValue = string | string[] | undefined;
export type HeaderRecord = Record<string, HeaderValue>;
type CachedBody = Uint8Array | string | null;

export function createHeaders(source: HeaderRecord): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

export function createNodeRequest(
  url: string,
  method: string,
  headers: Headers,
  bodySource: IncomingMessage,
): Request {
  const init: StreamRequestInit = { method, headers };
  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    init.body = bodySource as unknown as RequestBody;
    init.duplex = "half";
  }
  return new Request(url, init);
}

export async function readJsonRequestBody(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

export class NodeRequestState {
  private requestCache?: Request;
  private bodyCache?: CachedBody;

  constructor(
    private readonly url: string,
    private readonly method: string,
    private readonly headersSource: HeaderRecord,
    private readonly bodySource: IncomingMessage,
  ) {}

  get request(): Request {
    this.requestCache ??= this.buildRequest();
    return this.requestCache;
  }

  header(name: string): string | undefined {
    const value = this.headersSource[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value ?? undefined;
  }

  async readJsonBody(): Promise<unknown> {
    const body = await this.readBody();
    if (body === null) {
      return null;
    }

    try {
      const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  private buildRequest(): Request {
    const headers = createHeaders(this.headersSource);

    if (this.bodyCache !== undefined) {
      const init: RequestInit = { method: this.method, headers };
      if (this.bodyCache !== null) {
        init.body = this.bodyCache;
      }
      return new Request(this.url, init);
    }

    return createNodeRequest(this.url, this.method, headers, this.bodySource);
  }

  private async readBody(): Promise<CachedBody> {
    if (BODYLESS_METHODS.has(this.method.toUpperCase())) {
      this.bodyCache = null;
      return null;
    }

    if (this.bodyCache !== undefined) {
      return this.bodyCache;
    }

    if (this.requestCache && !this.requestCache.bodyUsed) {
      try {
        const clone = this.requestCache.clone();
        const bytes = new Uint8Array(await clone.arrayBuffer());
        this.bodyCache = bytes;
        return this.bodyCache;
      } catch {
        this.bodyCache = null;
        return null;
      }
    }

    this.bodyCache = await new Promise<CachedBody>((resolve, reject) => {
      let text = "";
      this.bodySource.on("data", (chunk: Buffer | string) => {
        text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      this.bodySource.on("end", () => {
        resolve(text === "" ? null : text);
      });
      this.bodySource.on("error", reject);
    });
    return this.bodyCache;
  }
}

export function responseToNodeStream(response: Response): Readable | null {
  if (!response.body) {
    return null;
  }
  return Readable.fromWeb(response.body);
}

export async function pipeResponseBody(
  response: Response,
  destination: NodeJS.WritableStream,
): Promise<void> {
  const body = responseToNodeStream(response);
  if (!body) {
    destination.end();
    return;
  }
  await pipeline(body, destination);
}

export function applyResponseHeaders(
  response: Response,
  setHeader: (name: string, value: string) => void,
): void {
  response.headers.forEach((value, key) => {
    setHeader(key, value);
  });
}
