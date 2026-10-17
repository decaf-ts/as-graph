/**
 * @module as-graph/nodes/agents/rag/chains/basic
 * @summary Mastra Basic LLM chain node declaration (SAA-836 M4).
 * @description Basic LLM chain: a single prompt-in/text-out model call, compiled
 * to a mastra workflow step through `MastraWorkflowCompiler`. The LLM is carried
 * as **config** (`modelAdapter`, R1) and the chain resolves into a JSON-safe
 * resource descriptor (R9); the live chain runs on the mastra backend.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../../shared/graph";
import { GraphNode } from "../../../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../../engine/types";

/** Inputs accepted by the basic LLM chain node. */
export type AgentBasicChainInput = Record<string, unknown>;

/** Outputs produced by the basic LLM chain node. */
export interface AgentBasicChainOutput {
  text: unknown;
  resource: unknown;
}

/**
 * Mastra Basic LLM chain node: runs a single prompt against a configured model.
 */
@node("core.agent.chain.basic", {
  kind: "core.agent.chain.basic",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "chain", "llm"],
  metadata: {
    title: "graph.node.agent.chain.basic.name",
    description: "graph.node.agent.chain.basic.description",
    shape: "rectangle",
  },
})
@model()
export class AgentBasicChainNode extends GraphNode<
  AgentBasicChainInput,
  AgentBasicChainOutput
> {
  /**
   * Resolves the basic chain config into a JSON-safe descriptor (R9).
   *
   * @param {GraphNodeExecutionRequest<AgentBasicChainInput>} request - Execution request.
   * @return {GraphExecutionValues} The `text`/`resource` outputs.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentBasicChainInput>
  ): GraphExecutionValues {
    const adapter = (this.modelAdapter ?? {}) as Record<string, unknown>;
    return {
      text: typeof request.inputs["text"] === "string" ? request.inputs["text"] : "",
      resource: {
        type: "mastra.chain.basic",
        provider: adapter["provider"],
        modelId: adapter["modelId"],
        promptTemplate: this.promptTemplate,
      },
    };
  }

  /** Input carrying the prompt text/input for the model. */
  @required()
  @input({ handle: "input" })
  input!: unknown;

  /**
   * The LLM backing the chain, carried as **config** (R1): `provider`,
   * `modelId`, and an optional credential reference.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chain.basic.fields.modelAdapter.label",
    type: "object",
  })
  @input({ handle: "modelAdapter", userControlled: true, type: "object" })
  modelAdapter?: Record<string, unknown>;

  /** Optional prompt template the input is interpolated into. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.chain.basic.fields.promptTemplate.label",
    type: "textarea",
  })
  @input({ handle: "promptTemplate", userControlled: true })
  promptTemplate?: string;

  /** Output carrying the model's text. */
  @required()
  @output({ handle: "text" })
  text!: unknown;

  /** Output carrying the resolved chain resource descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in basic LLM chain node constructors. */
export const GRAPH_AGENT_BASIC_CHAIN_NODES = [AgentBasicChainNode] as const;
