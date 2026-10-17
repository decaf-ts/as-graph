/**
 * @module as-graph/nodes/agents/rag/langchain-code
 * @summary LangChain Code node declaration (SAA-836 M4).
 * @description Custom AI-glue node: user-authored code that runs on the mastra
 * engine to bridge AI objects in a RAG graph. It carries the code as config and
 * resolves into a JSON-safe resource descriptor (R9); the code is **never
 * executed by the general engine** — the kind requires the mastra engine (R4),
 * which runs the code in its own sandbox. The node's `execute` only projects the
 * config, so no untrusted code runs on the local path.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";

/** Inputs accepted by the LangChain Code node. */
export type AgentLangChainCodeInput = Record<string, unknown>;

/** Outputs produced by the LangChain Code node. */
export interface AgentLangChainCodeOutput {
  output: unknown;
  resource: unknown;
}

/**
 * LangChain Code node: user-authored AI glue compiled into a mastra step.
 */
@node("core.agent.langchainCode", {
  kind: "core.agent.langchainCode",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "code", "glue"],
  metadata: {
    title: "graph.node.agent.langchain_code.name",
    description: "graph.node.agent.langchain_code.description",
    shape: "rectangle",
  },
})
@model()
export class AgentLangChainCodeNode extends GraphNode<
  AgentLangChainCodeInput,
  AgentLangChainCodeOutput
> {
  /**
   * Projects the code configuration into a JSON-safe resource descriptor. No
   * code is executed here: the mastra engine runs the code in its sandbox.
   *
   * @param {GraphNodeExecutionRequest<AgentLangChainCodeInput>} request - Execution request.
   * @return {GraphExecutionValues} The `output`/`resource` outputs.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentLangChainCodeInput>
  ): GraphExecutionValues {
    return {
      output: request.inputs["input"] ?? null,
      resource: {
        type: "mastra.langchainCode",
        language: this.language ?? "javascript",
        mode: this.mode ?? "runOnce",
        hasCode: typeof this.code === "string" && this.code.length > 0,
      },
    };
  }

  /** Input carrying the value passed into the user code. */
  @required()
  @input({ handle: "input" })
  input!: unknown;

  /** The user-authored glue code. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.langchain_code.fields.code.label",
    type: "textarea",
  })
  @input({ handle: "code", userControlled: true })
  code!: string;

  /** The code language. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.langchain_code.fields.language.label",
    type: "select",
  })
  @input({ handle: "language", userControlled: true })
  language?: "javascript" | "typescript";

  /** How the code runs over an input list (`runOnce` per item vs `runAll`). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.langchain_code.fields.mode.label",
    type: "select",
  })
  @input({ handle: "mode", userControlled: true })
  mode?: "runOnce" | "runAll";

  /** Output carrying the user code's result. */
  @output({ handle: "output" })
  outputOut!: unknown;

  /** Output carrying the resolved code resource descriptor (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;
}

/** All built-in LangChain Code node constructors. */
export const GRAPH_AGENT_LANGCHAIN_CODE_NODES = [AgentLangChainCodeNode] as const;
