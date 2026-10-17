/**
 * @module as-graph/nodes/agents/rag/structured-output-parser
 * @summary Structured Output Parser node declaration (SAA-836 M4).
 * @description Parses a model's raw text into the structured shape declared in
 * the node's `structuredOutput` schema (authored through the model-builder
 * component). It is a deterministic, model-free parsing step: it parses the
 * supplied text (JSON) or yields `null`, and exposes its resolution as a
 * JSON-safe resource descriptor (R9).
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the structured-output parser node. */
export type AgentStructuredOutputParserInput = Record<string, unknown>;

/** Outputs produced by the structured-output parser node. */
export interface AgentStructuredOutputParserOutput {
  object: unknown;
  resource: unknown;
}

/**
 * Parses JSON text, returning `null` for empty or invalid input.
 *
 * @param text - The candidate JSON text.
 * @returns The parsed value, or `null`.
 */
function parseJsonText(text: unknown): unknown {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Structured Output Parser node: turns model text into the declared structured
 * shape.
 */
@node("core.agent.structuredOutputParser", {
  kind: "core.agent.structuredOutputParser",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "parser", "structured-output"],
  metadata: {
    title: "graph.node.agent.structured_output_parser.name",
    description: "graph.node.agent.structured_output_parser.description",
    shape: "rectangle",
  },
})
@model()
export class AgentStructuredOutputParserNode extends GraphNode<
  AgentStructuredOutputParserInput,
  AgentStructuredOutputParserOutput
> {
  /**
   * Parses the resolved `text` input into the structured output.
   *
   * @param {GraphNodeExecutionRequest<AgentStructuredOutputParserInput>} request - Execution request.
   * @return {GraphExecutionValues} The `object`/`resource` outputs.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentStructuredOutputParserInput>
  ): GraphExecutionValues {
    const text = request.inputs["text"] ?? request.inputs["input"];
    return {
      object: parseJsonText(text),
      resource: {
        type: "mastra.structuredOutputParser",
        strict: this.strict ?? false,
        hasSchema: this.structuredOutput !== undefined,
      },
    };
  }

  /** Input carrying the raw model text to parse. */
  @required()
  @input({ handle: "text" })
  text!: unknown;

  /** The structured-output schema authored via the model-builder component. */
  @uielement("ngx-decaf-model-builder", {
    label: "graph.node.agent.structured_output_parser.fields.structuredOutput.label",
  })
  @input({ handle: "structuredOutput", userControlled: true, type: "object" })
  structuredOutput?: unknown;

  /** Whether the mastra backend rejects parsed values that do not satisfy
   * the schema; the local parse step only parses JSON and never rejects. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.structured_output_parser.fields.strict.label",
    type: "boolean",
  })
  @input({ handle: "strict", userControlled: true })
  strict?: boolean;

  /** Output carrying the parsed structured value. */
  @required()
  @output({ handle: "object" })
  object!: unknown;

  /** Output carrying the resolved parser resource descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in structured-output parser node constructors. */
export const GRAPH_AGENT_STRUCTURED_OUTPUT_PARSER_NODES = [
  AgentStructuredOutputParserNode,
] as const;
