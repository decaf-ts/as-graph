/**
 * @module as-graph/validation/GraphPortSchemaResolver
 * @summary Resolves graph port definitions to Zod schemas.
 * @description Prefers `@decaf-ts/as-zod` for model-backed ports and falls back to primitive type mapping.
 */
import type { GraphPortDefinition } from "../../shared/graph";

/**
 * Resolves a {@link GraphPortDefinition} to a Zod schema (or a lightweight
 * validation function when Zod is not available).
 *
 * This implementation uses primitive type mapping. When the port's `model`
 * field or underlying Decaf metadata references a `Model` class, consumers
 * should use `modelToZod` from `@decaf-ts/as-zod` to build the schema.
 */
export class GraphPortSchemaResolver {
  /**
   * Resolves a single port to a schema descriptor.
   *
   * @returns A descriptor with the port name, a `validate` function, and
   * optional Zod schema reference.
   */
  resolve(port: GraphPortDefinition): {
    name: string;
    required: boolean;
    validate: (value: unknown) => boolean;
  } {
    const validate = this.createValidator(port);
    return { name: port.name, required: port.required, validate };
  }

  /**
   * Resolves multiple ports into a map of name -> descriptor.
   */
  resolveAll(ports: GraphPortDefinition[]): Record<string, { name: string; required: boolean; validate: (value: unknown) => boolean }> {
    const result: Record<string, { name: string; required: boolean; validate: (value: unknown) => boolean }> = {};
    for (const port of ports) {
      result[port.name] = this.resolve(port);
    }
    return result;
  }

  /**
   * Creates a validation function based on the port's type.
   */
  private createValidator(port: GraphPortDefinition): (value: unknown) => boolean {
    const type = (port.type ?? port.designType ?? "").toLowerCase();
    switch (type) {
      case "string":
        return (v) => typeof v === "string";
      case "number":
        return (v) => typeof v === "number";
      case "boolean":
        return (v) => typeof v === "boolean";
      case "date":
        return (v) => v instanceof Date || (typeof v === "string" && !isNaN(Date.parse(v)));
      case "array":
        return (v) => Array.isArray(v);
      case "bigint":
        return (v) => typeof v === "bigint";
      default:
        return () => true;
    }
  }
}
