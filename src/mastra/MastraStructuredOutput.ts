/**
 * @module as-graph/mastra/MastraStructuredOutput
 * @summary Backend contract for structured output/input definitions (SAA-836 S1).
 * @description A graph document authors a structured-output definition on an
 * agent (or a structured-output consuming node) as a plain, JSON-safe
 * parameter. This module is the backend contract for that definition: its
 * shape, its resolution into the `@mastra/core` `structuredOutput` generate
 * option, and its fail-closed semantics. The schema itself always comes from
 * the single decaf↔mastra conversion path ({@link MastraModelSchemaConverter}
 * over `@decaf-ts/as-zod`): either a decaf model name resolved through the
 * host-supplied model registry, or an already-converted Zod schema carried by
 * the host. The definition never carries a secret and never carries raw JSON
 * Schema — mastra consumes Zod. The model-builder UI (SAA-836 U1) consumes
 * this same contract; no UI is authored here.
 *
 * @mermaid
 * sequenceDiagram
 *   autonumber
 *   participant N as Canonical node structuredOutput parameter
 *   participant SH as MastraAgentStepHandler step
 *   participant R as mastraStructuredOutputOf / resolveMastraStructuredOutput
 *   participant C as MastraModelSchemaConverter (as-zod)
 *   participant RT as config-backed MastraAgentRuntime
 *   participant A as mastra agent generate
 *   N->>SH: structuredOutput definition (parameters)
 *   SH->>R: mastraStructuredOutputOf(node, resolveModel) (memoized per step)
 *   alt no structuredOutput parameter declared on the node
 *     R-->>SH: undefined (agent runs unstructured)
 *   else declared parameter is not a valid definition
 *     R--xSH: GRAPH_MASTRA_STRUCTURED_OUTPUT_MALFORMED
 *   else definition present
 *     alt host-carried Zod schema
 *       R-->>R: schema = definition.schema
 *     else decaf model name
 *       R->>R: resolveModel(name)
 *       alt registry misses
 *         R--xSH: GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED
 *       else registry resolves
 *         R->>C: mastraSchemaFromModel(model)
 *         alt conversion fails / non-object schema
 *           C--xSH: GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE
 *         else converted
 *           C-->>R: Zod object schema
 *         end
 *       end
 *     end
 *     R-->>SH: MastraResolvedStructuredOutput
 *     SH->>RT: execute(node, inputs, …, structuredOutput)
 *     RT->>A: generate(prompt, { structuredOutput: { schema, … } })
 *     A-->>RT: response validated against the Zod schema
 *   end
 */
import type { Constructor } from "@decaf-ts/decoration";
import type { Model } from "@decaf-ts/decorator-validation";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import {
  mastraSchemaFromModel,
} from "./MastraModelSchemaConverter";
import type { z } from "zod";

/** The structured-output definition on a node could not be resolved. */
export const GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED =
  "GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED";

/**
 * A node declares a `structuredOutput` parameter that is not a valid
 * structured-output definition. Fails the run instead of silently stripping
 * the declared output-validation control.
 */
export const GRAPH_MASTRA_STRUCTURED_OUTPUT_MALFORMED =
  "GRAPH_MASTRA_STRUCTURED_OUTPUT_MALFORMED";

/**
 * Host-supplied registry resolving a decaf model name to its constructor.
 * The host owns the model catalogue; the mastra backend never invents one.
 */
export type MastraDecafModelResolver = (
  name: string
) => Constructor<Model> | undefined;

/**
 * The JSON-safe structured-output definition a document authors on a node
 * (backend contract, consumed by the U1 model-builder UI). The schema is
 * either referenced by decaf model name (`model`) or supplied by the host as
 * an already-converted Zod schema (`schema`); exactly one must resolve.
 */
export interface MastraStructuredOutputDefinition {
  /** The decaf model name the schema is derived from (as-zod conversion). */
  model?: string;
  /**
   * An already-converted Zod schema supplied by the host (never user JSON).
   * Takes precedence over {@link model} when both are present.
   */
  schema?: z.ZodTypeAny;
  /**
   * Optional structuring instructions forwarded to mastra verbatim (mastra's
   * `structuredOutput.instructions`).
   */
  instructions?: string;
  /**
   * Optional prompt-injection mode forwarded to mastra verbatim (mastra's
   * `structuredOutput.jsonPromptInjection`).
   */
  jsonPromptInjection?: boolean | "system" | "inline" | "auto";
  /** Optional provider-specific options forwarded to mastra verbatim. */
  providerOptions?: Record<string, unknown>;
}

/** The resolved, mastra-ready structured-output option for one node. */
export interface MastraResolvedStructuredOutput {
  /** The Zod schema the agent's structured output validates against. */
  schema: z.ZodTypeAny;
  /** Optional structuring instructions forwarded to mastra. */
  instructions?: string;
  /** Optional prompt-injection mode forwarded to mastra. */
  jsonPromptInjection?: boolean | "system" | "inline" | "auto";
  /** Optional provider-specific options forwarded to mastra. */
  providerOptions?: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isZodSchemaLike(value: unknown): value is z.ZodTypeAny {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { parse?: unknown }).parse === "function"
  );
}

/**
 * Structural guard for {@link MastraStructuredOutputDefinition}: accepts the
 * plain, JSON-safe definition shape authored on a node. A live Zod schema
 * passes only through the host-carried `schema` field.
 *
 * @param value - The candidate definition.
 * @returns `true` when the value is a valid structured-output definition.
 */
export function isMastraStructuredOutputDefinition(
  value: unknown
): value is MastraStructuredOutputDefinition {
  if (!isPlainRecord(value)) return false;
  const model = value["model"];
  if (model !== undefined && typeof model !== "string") return false;
  const schema = value["schema"];
  if (schema !== undefined && !isZodSchemaLike(schema)) return false;
  const instructions = value["instructions"];
  if (instructions !== undefined && typeof instructions !== "string") {
    return false;
  }
  const injection = value["jsonPromptInjection"];
  if (
    injection !== undefined &&
    injection !== true &&
    injection !== false &&
    injection !== "system" &&
    injection !== "inline" &&
    injection !== "auto"
  ) {
    return false;
  }
  const providerOptions = value["providerOptions"];
  if (providerOptions !== undefined && !isPlainRecord(providerOptions)) {
    return false;
  }
  return true;
}

/**
 * Reads the structured-output definition authored on a canonical node's
 * `structuredOutput` parameter. An absent parameter returns `undefined` so
 * the caller runs unstructured (the default mastra behaviour); a DECLARED
 * parameter that fails the guard throws — a declared output-validation
 * control that is malformed must never silently degrade the agent to
 * unstructured output (fail closed, not fail silent).
 *
 * @param node - The canonical node instance.
 * @returns The validated definition, or `undefined` when no parameter is
 *   declared.
 * @throws {GraphExecutionError}
 *   {@link GRAPH_MASTRA_STRUCTURED_OUTPUT_MALFORMED} when the node declares
 *   a `structuredOutput` parameter that is not a valid definition.
 */
export function mastraStructuredOutputDefinitionOf(
  node: GraphNodeInstance
): MastraStructuredOutputDefinition | undefined {
  const parameters = node.parameters;
  if (!parameters || !("structuredOutput" in parameters)) return undefined;
  const candidate = parameters["structuredOutput"];
  if (candidate === undefined) return undefined;
  if (!isMastraStructuredOutputDefinition(candidate)) {
    throw new GraphExecutionError(
      "The node declares a 'structuredOutput' parameter that is not a valid structured-output definition",
      GRAPH_MASTRA_STRUCTURED_OUTPUT_MALFORMED,
      { nodeKind: node.kind }
    );
  }
  return candidate;
}

/**
 * Resolves a {@link MastraStructuredOutputDefinition} into the mastra
 * `structuredOutput` generate option (SAA-836 S1). The schema comes from the
 * single conversion path: a host-carried Zod schema when supplied, otherwise
 * the decaf model named by the definition resolved through
 * {@link resolveModel} and converted via `@decaf-ts/as-zod`. Fails closed
 * when neither source resolves — a structured-output definition that cannot
 * resolve must never silently degrade to unstructured output.
 *
 * @param definition - The validated definition.
 * @param resolveModel - The host decaf-model registry; required when the
 *   definition references a model by name.
 * @returns The resolved, mastra-ready structured-output option.
 * @throws {GraphExecutionError}
 *   {@link GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED} when no schema source
 *   resolves, or {@link GRAPH_MASTRA_MODEL_SCHEMA_UNAVAILABLE} when the
 *   referenced decaf model cannot be converted.
 */
export function resolveMastraStructuredOutput(
  definition: MastraStructuredOutputDefinition,
  resolveModel?: MastraDecafModelResolver
): MastraResolvedStructuredOutput {
  let schema = definition.schema;
  if (!schema && definition.model) {
    const model = resolveModel?.(definition.model);
    if (!model) {
      throw new GraphExecutionError(
        `Structured output references decaf model '${definition.model}', which the host registry does not resolve`,
        GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED,
        { model: definition.model }
      );
    }
    schema = mastraSchemaFromModel(model);
  }
  if (!schema) {
    throw new GraphExecutionError(
      "A structured-output definition resolves no schema: carry a decaf model name or a host-converted Zod schema",
      GRAPH_MASTRA_STRUCTURED_OUTPUT_UNRESOLVED
    );
  }
  return {
    schema,
    ...(definition.instructions !== undefined
      ? { instructions: definition.instructions }
      : {}),
    ...(definition.jsonPromptInjection !== undefined
      ? { jsonPromptInjection: definition.jsonPromptInjection }
      : {}),
    ...(definition.providerOptions !== undefined
      ? { providerOptions: definition.providerOptions }
      : {}),
  };
}

/**
 * Reads the structured-output definition authored on a canonical node's
 * `structuredOutput` parameter and resolves it against the host model
 * registry. When the node declares no parameter, the resolution is absent —
 * the agent runs unstructured, which is the default mastra behaviour. A
 * declared parameter that is not a valid definition fails the run.
 *
 * @param node - The canonical node instance.
 * @param resolveModel - The host decaf-model registry.
 * @returns The resolved structured-output option, or `undefined` when the
 *   node declares none.
 * @throws {GraphExecutionError} when a declared definition cannot resolve.
 */
export function mastraStructuredOutputOf(
  node: GraphNodeInstance,
  resolveModel?: MastraDecafModelResolver
): MastraResolvedStructuredOutput | undefined {
  const definition = mastraStructuredOutputDefinitionOf(node);
  if (!definition) return undefined;
  return resolveMastraStructuredOutput(definition, resolveModel);
}
