/**
 * @module as-graph/mastra/MastraToolDecorator
 * @summary `@tool` decorator turning service methods into mastra tools (SAA-836 M3).
 * @description Converts a decaf service method into a mastra tool, mirroring the
 * alfred prototype (`brain/src/core/services/decorators.ts`) read-only: the
 * decorator validates the target is a method, records a {@link ToolMethodMetadata}
 * entry keyed by the tool id on the service class, and is read back either as
 * metadata ({@link serviceToolMethods}) or as real mastra tools
 * ({@link mastraToolsFromService}) through the real `@mastra/core` `createTool`.
 *
 * Unlike the prototype, the input/output schemas are taken from the explicit
 * decorator options when supplied (the S1 as-zod conversion path owns model →
 * mastra schema conversion); the prototype's reflection-only inference is not
 * reproduced so the conversion has exactly one authority.
 */
import { Metadata, apply, metadata } from "@decaf-ts/decoration";
import type { Constructor } from "@decaf-ts/decoration";
import { InternalError } from "@decaf-ts/db-decorators";
import { createMastraTool } from "./MastraToolConfig";
import type { MastraToolDefinition } from "./MastraToolConfig";

/** Metadata key under which `@tool` entries are recorded on a service class. */
export const GRAPH_TOOL_METADATA_KEY = "graph.tool";

/** Options supplied to the `@tool` decorator. */
export interface ToolOptions {
  /** The mastra tool id; the metadata key on the service class. */
  id: string;
  /** The human/model-facing tool description. */
  description: string;
  /** The explicit input schema (a zod schema or model-derived schema). */
  inputSchema?: unknown;
  /** The explicit output schema (a zod schema or model-derived schema). */
  outputSchema?: unknown;
}

/** A recorded tool method on a service class. */
export interface ToolMethodMetadata extends ToolOptions {
  /** The service method name the tool delegates to. */
  propertyKey: string;
}

/**
 * Declares a service method as a mastra tool.
 *
 * The method is called with the tool input and may return a value or a promise;
 * the result becomes the mastra tool output.
 *
 * @param options - The tool id, description, and optional schemas.
 * @returns The method decorator.
 * @throws {InternalError} when applied to a non-method target.
 */
export function tool(options: ToolOptions) {
  return function decorate(
    target: object,
    propertyKey: string,
    descriptor?: PropertyDescriptor
  ): unknown {
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new InternalError(
        `@tool can only be applied to methods (received '${propertyKey}')`
      );
    }
    if (!options.id) {
      throw new InternalError(
        `@tool on '${propertyKey}' requires a non-empty tool id`
      );
    }
    const meta: ToolMethodMetadata = {
      id: options.id,
      description: options.description,
      inputSchema: options.inputSchema,
      outputSchema: options.outputSchema,
      propertyKey,
    };
    return apply(
      metadata(Metadata.key(GRAPH_TOOL_METADATA_KEY, options.id), meta)
    )(target, propertyKey, descriptor);
  };
}

/**
 * Reads every `@tool` method recorded on a service class.
 *
 * @param model - The service class constructor.
 * @returns The recorded tool methods (empty when the class declares none).
 */
export function serviceToolMethods(
  model: Constructor
): ToolMethodMetadata[] {
  const resolved = Metadata.constr(model);
  const recorded = Metadata.get(
    resolved,
    GRAPH_TOOL_METADATA_KEY
  ) as Record<string, ToolMethodMetadata> | undefined;
  return recorded ? Object.values(recorded) : [];
}

/**
 * Resolves a service instance's `@tool` methods into real mastra tools.
 *
 * Each tool's `execute` delegates to the service method with the supplied
 * input; the method's return value (or promise) becomes the tool output.
 *
 * @param service - The service instance carrying `@tool`-decorated methods.
 * @returns A map of tool id → mastra `Tool` instance.
 */
export function mastraToolsFromService(
  service: object
): Record<string, unknown> {
  const model = service.constructor as Constructor;
  const methods = serviceToolMethods(model);
  const tools: Record<string, unknown> = {};
  for (const method of methods) {
    const fn = (service as Record<string, unknown>)[method.propertyKey];
    if (typeof fn !== "function") {
      throw new InternalError(
        `@tool '${method.id}' references missing method '${method.propertyKey}'`
      );
    }
    const definition: MastraToolDefinition = {
      id: method.id,
      description: method.description,
      inputSchema: method.inputSchema,
      outputSchema: method.outputSchema,
      execute: async (input: unknown) => {
        const callable = fn as (input: unknown) => unknown | Promise<unknown>;
        return await callable.call(service, input);
      },
    };
    tools[method.id] = createMastraTool(definition);
  }
  return tools;
}
