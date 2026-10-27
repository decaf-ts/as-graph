/**
 * @module as-graph/mastra/nodes/rag/langchain-code
 * @summary LangChain Code node declaration (SAA-836 M4).
 * @description Custom AI-glue node: user-authored code that runs on the Mastra
 * engine to bridge AI objects in a RAG graph. The code is carried as config
 * and executed by the run-scoped RAG runtime service in its own sandbox with
 * the shared timeout ceiling. The local engine rejects this kind through the
 * engine-requirement gate (R4); on the Mastra engine the node's `execute()` is
 * the single implementation, invoked through the Mastra step adapter, so no
 * untrusted code runs on the local path.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../../node/base";
import {
  mastraNodeRuntimeOf,
  mastraServiceUnavailableCode,
  requireMastraNodeService,
} from "../../MastraNodeExecutionServices";
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
   * Executes the declared node semantics through the run-scoped RAG execution
   * services (embedding, generation, vector store, and sandbox host ports). A
   * missing service fails closed with a stable typed graph execution error.
   *
   * @param {GraphNodeExecutionRequest<AgentLangChainCodeInput>} request - Execution request.
   * @return {Promise<GraphExecutionValues>} The node outputs.
   */
  override async execute(
    request: GraphNodeExecutionRequest<AgentLangChainCodeInput>
  ): Promise<GraphExecutionValues> {
    const runtime = requireMastraNodeService(
      request,
      "rag",
      mastraServiceUnavailableCode("rag")
    );
    const mastra = mastraNodeRuntimeOf(request)!;
    return runtime.execute(
      request.kind,
      mastra.node,
      request.inputs,
      mastra.document,
      mastra.signal
    );
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
