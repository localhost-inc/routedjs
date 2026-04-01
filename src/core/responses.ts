import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ResponseStatus, RouteSchemas } from "./types.ts";

export function getResponseSchemas(schemas: RouteSchemas): Map<number, StandardSchemaV1> {
  const responseSchemas = new Map<number, StandardSchemaV1>();

  if (schemas.response) {
    responseSchemas.set(200, schemas.response);
  }

  if (schemas.responses) {
    for (const [rawStatus, schema] of Object.entries(schemas.responses)) {
      if (!schema) continue;

      const status = parseResponseStatus(rawStatus);
      if (status === null) continue;

      responseSchemas.set(status, schema);
    }
  }

  return responseSchemas;
}

export function getResponseSchemaForStatus(
  schemas: RouteSchemas,
  status: number,
): StandardSchemaV1 | undefined {
  return getResponseSchemas(schemas).get(status);
}

function parseResponseStatus(status: ResponseStatus | string): number | null {
  const parsedStatus = Number(status);

  if (!Number.isInteger(parsedStatus) || parsedStatus < 100 || parsedStatus > 599) {
    return null;
  }

  return parsedStatus;
}
