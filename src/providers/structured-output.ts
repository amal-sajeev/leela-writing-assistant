import type { Logger } from "../utils/logger";
import { isProviderError } from "./provider-errors";

/**
 * Shared structured-output handling (specification section 12).
 *
 * Every vendor has its own way of asking for JSON that matches a schema, and
 * its own way of refusing. What they have in common lives here, so all three
 * providers degrade the same way rather than each inventing its own recovery.
 */

/** Strict schema first, plain JSON second, prompt-only last. */
export type StructuredMode = "schema" | "json" | "none";

/**
 * True when a request failed because the model would not accept the strict
 * schema, as opposed to a genuine client error such as a bad model name.
 */
export function isSchemaRejection(error: unknown): boolean {
  if (!isProviderError(error)) return false;
  if (error.status !== 400 && error.status !== 422) return false;
  return /schema|response_format|structured|output_config|output_format/i.test(error.message);
}

/**
 * Runs a request with structured output, retrying once in a weaker mode when
 * the model rejects the schema.
 *
 * Not every model accepts a strict schema. Our own validation still runs on
 * whatever comes back, so degrading produces usable output where failing would
 * produce none.
 */
export async function withSchemaFallback<T>(
  send: (mode: StructuredMode) => Promise<T>,
  options: { fallback: StructuredMode; model: string; logger?: Logger },
): Promise<T> {
  try {
    return await send("schema");
  } catch (error) {
    if (!isSchemaRejection(error)) throw error;

    options.logger?.warn("model rejected strict schema, retrying without it", {
      model: options.model,
      fallback: options.fallback,
      status: isProviderError(error) ? error.status : undefined,
    });

    return await send(options.fallback);
  }
}

/** Trims provider-incompatible schema features; Zod still validates parsed output. */
const UNSUPPORTED_CONSTRAINTS: ReadonlySet<string> = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
]);

export function relaxNullableUnions(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(relaxNullableUnions);
  if (typeof schema !== "object" || schema === null) return schema;

  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const nullable = new Set<string>();

  for (const [key, value] of Object.entries(input)) {
    if (UNSUPPORTED_CONSTRAINTS.has(key) && typeof value === "number") continue;

    if (key !== "properties" || typeof value !== "object" || value === null) {
      output[key] = relaxNullableUnions(value);
      continue;
    }

    const properties: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
      const collapsed = withoutNullBranch(property);
      if (collapsed !== undefined) nullable.add(name);
      properties[name] = relaxNullableUnions(collapsed ?? property);
    }
    output.properties = properties;
  }

  if (nullable.size > 0 && Array.isArray(output.required)) {
    output.required = (output.required as unknown[]).filter(
      (name) => typeof name !== "string" || !nullable.has(name),
    );
  }

  return output;
}

/** The non-null branch of `anyOf: [X, null]`, or undefined when that is not the shape. */
function withoutNullBranch(property: unknown): Record<string, unknown> | undefined {
  if (typeof property !== "object" || property === null) return undefined;

  const record = property as Record<string, unknown>;
  const branches = record.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2) return undefined;

  const kept = branches.filter((branch) => !isNullType(branch));
  if (kept.length !== 1 || typeof kept[0] !== "object" || kept[0] === null) return undefined;

  // Keeps whatever else the property declared, such as its description.
  const rest = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "anyOf"));
  return { ...(kept[0] as Record<string, unknown>), ...rest };
}

function isNullType(branch: unknown): boolean {
  return (
    typeof branch === "object" &&
    branch !== null &&
    (branch as Record<string, unknown>).type === "null"
  );
}
