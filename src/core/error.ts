export class RouteError extends Error {
  readonly status: number;
  readonly data?: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "RouteError";
    this.status = status;
    this.data = data;
  }
}
