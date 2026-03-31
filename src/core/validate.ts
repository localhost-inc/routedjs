import type { StandardSchemaV1 } from "@standard-schema/spec";

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; issues: readonly StandardSchemaV1.Issue[] };

/**
 * Validate a value against a Standard Schema.
 * Works with Zod, Valibot, ArkType, or any Standard Schema-compliant library.
 */
export async function validateSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): Promise<ValidationResult<T>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    return { success: false, issues: result.issues };
  }
  return { success: true, data: result.value };
}
