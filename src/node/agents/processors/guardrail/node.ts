/**
 * @module as-graph/nodes/agents/processors/guardrail
 * @summary Mastra guardrail node declaration (SAA-836 M5).
 * @description Guardrail node composing with the agent's output-processor
 * pipeline: guardrails are the mastra processors that intercept invalid model
 * output (moderation, PII, prompt injection, regex rules) and — with the
 * `block` strategy — abort execution via mastra's tripwire. Per R9 it resolves
 * its configuration into the mastra guardrail resource on a real output port;
 * the mastra backend builds the real `@mastra/core/processors` instance and
 * appends it to the agent's per-run `outputProcessors`. Guardrail types that
 * need a classifier carry it as **config** via `modelAdapter` (R1 — no
 * model-provider node kind). Connects only to the agent `outputProcessors`
 * zone.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../../../shared/graph";
import { GraphNode } from "../../../base";
import { MASTRA_AGENT_ZONE } from "../../zones";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../../engine/types";
import { MASTRA_GUARDRAIL_TYPES } from "../types";

/** Inputs accepted by the guardrail node. */
export type AgentGuardrailInput = Record<string, unknown>;

/** Outputs produced by the guardrail node. */
export interface AgentGuardrailOutput {
  resource: unknown;
}

/**
 * Mastra guardrail node: intercepts invalid model output on the agent's
 * `outputProcessors` zone and can abort execution via mastra's tripwire.
 */
@node("core.agent.guardrail", {
  kind: "core.agent.guardrail",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "guardrail", "safety"],
  metadata: {
    title: "graph.node.agent.guardrail.name",
    description: "graph.node.agent.guardrail.description",
    shape: "rectangle",
  },
})
@model()
export class AgentGuardrailNode extends GraphNode<
  AgentGuardrailInput,
  AgentGuardrailOutput
> {
  /**
   * Resolves the configured guardrail into the mastra guardrail resource
   * descriptor returned on the `resource` output port (R9 preferred shape;
   * the mastra backend builds the live processor from this descriptor).
   *
   * @param {GraphNodeExecutionRequest<AgentGuardrailInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource` output value.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentGuardrailInput>
  ): GraphExecutionValues {
    return {
      resource: {
        type: "mastra.guardrail",
        guardrailType: this.guardrailType,
        strategy: this.strategy,
        options: this.options,
        input: request.inputs,
      },
    };
  }

  /** The mastra-native guardrail type this node resolves to. */
  @required()
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.guardrail.fields.guardrailType.label",
    type: "select",
  })
  @input({ handle: "guardrailType", userControlled: true })
  guardrailType!: (typeof MASTRA_GUARDRAIL_TYPES)[number];

  /**
   * How a detection is handled (mastra `strategy`): `block` aborts execution
   * via the tripwire; `warn`/`filter`/`redact`/`rewrite` annotate, drop, or
   * rewrite the flagged traffic instead.
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.guardrail.fields.strategy.label",
    type: "select",
  })
  @input({ handle: "strategy", userControlled: true })
  strategy?: "block" | "warn" | "filter" | "redact" | "rewrite";

  /** The guardrail options forwarded to the mastra processor constructor. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.guardrail.fields.options.label",
    type: "object",
  })
  @input({ handle: "options", userControlled: true, type: "object" })
  options?: Record<string, unknown>;

  /**
   * The classifier LLM for model-carrying guardrail types (`moderation`,
   * `piiDetector`, `promptInjectionDetector`), carried as **config** (R1):
   * `provider`, `modelId`, and an optional credential reference. Ignored by
   * guardrail types that take no model (`regexFilter`).
   */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.guardrail.fields.modelAdapter.label",
    type: "object",
  })
  @input({ handle: "modelAdapter", userControlled: true, type: "object" })
  modelAdapter?: Record<string, unknown>;

  /** Output carrying the resolved mastra guardrail resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `outputProcessors` zone. */
  @connection({
    category: MASTRA_AGENT_ZONE.outputProcessors,
    handle: "guardrail",
  })
  guardrail!: unknown;
}

/** All built-in guardrail node constructors. */
export const GRAPH_AGENT_GUARDRAIL_NODES = [AgentGuardrailNode] as const;
