import { describe, expect, it } from "vitest";

import { ProviderError } from "../src/providers/provider-errors";
import {
  documentObservationsJsonSchema,
  reviewJsonSchema,
  suggestedFixJsonSchema,
} from "../src/providers/schemas";
import {
  isSchemaRejection,
  relaxNullableUnions,
  withSchemaFallback,
  type StructuredMode,
} from "../src/providers/structured-output";

/** Reads a nested field without spelling out a type for every level. */
function dig(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((current, key) => (current as Record<string, unknown> | undefined)?.[key], value);
}

describe("isSchemaRejection", () => {
  it("recognises a refusal of the schema", () => {
    expect(
      isSchemaRejection(
        new ProviderError("provider_error", "invalid response_format", false, 400),
      ),
    ).toBe(true);
    expect(
      isSchemaRejection(
        new ProviderError("provider_error", "unsupported json schema for this model", false, 400),
      ),
    ).toBe(true);
    expect(
      isSchemaRejection(new ProviderError("provider_error", "output_config not supported", false, 422)),
    ).toBe(true);
  });

  it("does not mistake a genuine client error for a schema refusal", () => {
    expect(isSchemaRejection(new ProviderError("provider_error", "unknown model", false, 400))).toBe(
      false,
    );
    // A refusal that arrives without a status is a failure of some other kind.
    expect(
      isSchemaRejection(new ProviderError("provider_error", "invalid response_format", false)),
    ).toBe(false);
    expect(
      isSchemaRejection(new ProviderError("unauthorized", "invalid api key schema", false, 401)),
    ).toBe(false);
    expect(isSchemaRejection(new Error("schema"))).toBe(false);
  });
});

describe("withSchemaFallback", () => {
  it("asks for the schema first and stops there when it works", async () => {
    const modes: StructuredMode[] = [];

    const result = await withSchemaFallback(
      (mode) => {
        modes.push(mode);
        return Promise.resolve("ok");
      },
      { fallback: "json", model: "test" },
    );

    expect(result).toBe("ok");
    expect(modes).toEqual(["schema"]);
  });

  it("retries once in the weaker mode when the schema is refused", async () => {
    const modes: StructuredMode[] = [];

    const result = await withSchemaFallback(
      (mode) => {
        modes.push(mode);
        if (mode === "schema") {
          return Promise.reject(
            new ProviderError("provider_error", "response_format unsupported", false, 400),
          );
        }
        return Promise.resolve("ok");
      },
      { fallback: "none", model: "test" },
    );

    expect(result).toBe("ok");
    expect(modes).toEqual(["schema", "none"]);
  });

  it("lets any other failure through untouched", async () => {
    const error = new ProviderError("unauthorized", "invalid key", false, 401);

    await expect(
      withSchemaFallback(() => Promise.reject(error), { fallback: "json", model: "test" }),
    ).rejects.toBe(error);
  });

  it("does not retry a second time when the weaker mode also fails", async () => {
    let calls = 0;

    await expect(
      withSchemaFallback(
        () => {
          calls += 1;
          return Promise.reject(new ProviderError("provider_error", "bad schema", false, 400));
        },
        { fallback: "json", model: "test" },
      ),
    ).rejects.toThrow();

    expect(calls).toBe(2);
  });
});

describe("relaxNullableUnions", () => {
  it("collapses a nullable property and drops it from required", () => {
    const relaxed = relaxNullableUnions(suggestedFixJsonSchema()) as Record<string, unknown>;
    const properties = relaxed.properties as Record<string, Record<string, unknown>>;

    expect(properties.explanation).toEqual({ type: "string" });
    expect(relaxed.required).toEqual(["replacement"]);
    const original = suggestedFixJsonSchema().properties as Record<string, unknown>;
    expect(properties.replacement).toEqual(original.replacement);
  });

  it("reaches nullable properties nested inside array items", () => {
    const items = dig(relaxNullableUnions(reviewJsonSchema()), "properties.comments.items");

    expect(dig(items, "properties.rationale")).toEqual({ type: "string" });
    expect(dig(items, "properties.reaction")).toEqual({ type: "string", enum: [
      "idle_embarassed", "idle_goodbye", "idle_happy", "idle_happy_resting", "idle_concerned", "idle_laughing", "idle_sad", "idle_serious", "idle_shocked_happy", "idle_shocked_sad", "idle_sulking", "idle_teasing", "idle_welcome",
    ] });
    expect(dig(items, "required")).toEqual([
      "quote",
      "category",
      "severity",
      "confidence",
      "body",
    ]);
  });

  it("keeps the description of a collapsed property", () => {
    const items = dig(
      relaxNullableUnions(documentObservationsJsonSchema()),
      "properties.observations.items",
    );

    expect(dig(items, "properties.relatedQuotes")).toEqual({
      type: "array",
      items: { type: "string" },
      description: "Short exact quotes from the note the author should look at.",
    });
    expect(dig(items, "required")).toEqual(["type", "title", "body"]);
  });

  it("leaves a schema with no nullable unions exactly as it was", () => {
    const plain = {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "string", enum: ["x", "y"] } },
    };

    expect(relaxNullableUnions(plain)).toEqual(plain);
  });

  it("leaves a union that is not nullable alone", () => {
    const schema = {
      type: "object",
      required: ["a"],
      properties: { a: { anyOf: [{ type: "string" }, { type: "number" }] } },
    };

    expect(relaxNullableUnions(schema)).toEqual(schema);
  });

  it("does not mutate the schema it was given", () => {
    const original = reviewJsonSchema();
    const copy = structuredClone(original);

    relaxNullableUnions(original);

    expect(original).toEqual(copy);
  });
});
