/**
 * @module as-graph/nodes/agents/sandbox
 * @summary Mastra Sandbox / filesystem node declaration (SAA-836 M3).
 * @description Sandbox node on the agent sandbox zone, mirroring mastra's
 * `LocalSandbox`/`Workspace` sandbox config. Its `timeoutMs` is clamped with the
 * same ceiling-guard path as the verified `GRAPH_CODE_SANDBOX_TIMEOUT` code node
 * (`GraphEnvironment.graph.execution.maxCodeTimeoutMs`, default
 * `GRAPH_CODE_MAX_TIMEOUT_MS`), so AI-executed code respects the guards. Per R9
 * it resolves its configuration into the mastra sandbox resource on a real
 * output port.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { connection, input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import { MASTRA_AGENT_ZONE } from "../zones";
import { clampGraphCodeTimeoutMs } from "../../utility/code/node";
import { GRAPH_CODE_MAX_TIMEOUT_MS } from "../../../engine/constants";
import { GraphEnvironment } from "../../../engine/services/GraphEnvironment";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the sandbox node. */
export type AgentSandboxInput = Record<string, unknown>;

/** Outputs produced by the sandbox node. */
export interface AgentSandboxOutput {
  resource: unknown;
}

/**
 * Resolves the effective sandbox `timeoutMs`, clamped to the backend ceiling.
 *
 * Mirrors the code node guard: the effective ceiling comes from
 * `GraphEnvironment.graph.execution.maxCodeTimeoutMs` and falls back to
 * {@link GRAPH_CODE_MAX_TIMEOUT_MS}, and a missing/invalid declared value
 * resolves to {@link GRAPH_CODE_DEFAULT_TIMEOUT_MS}. `Math.min` is only ever
 * evaluated with a finite ceiling, so a NaN ceiling can never surface.
 *
 * @param declared - The declared `timeoutMs` from the document.
 * @returns The clamped, positive timeout in milliseconds.
 */
export function clampSandboxTimeoutMs(declared: unknown): number {
  const environmentCeiling = GraphEnvironment.graph.execution?.maxCodeTimeoutMs;
  const maxTimeoutMs =
    typeof environmentCeiling === "number" &&
    Number.isFinite(environmentCeiling) &&
    environmentCeiling > 0
      ? environmentCeiling
      : GRAPH_CODE_MAX_TIMEOUT_MS;
  return clampGraphCodeTimeoutMs(declared, maxTimeoutMs);
}

/**
 * Mastra Sandbox node: supplies a configured sandbox/filesystem resource to the
 * agent's `sandbox` zone.
 */
@node("core.agent.sandbox", {
  kind: "core.agent.sandbox",
  category: "Agent",
  width: 128,
  height: 112,
  labels: ["agent", "ai", "sandbox", "filesystem"],
  metadata: {
    title: "graph.node.agent.sandbox.name",
    description: "graph.node.agent.sandbox.description",
    shape: "rectangle",
  },
})
@model()
export class AgentSandboxNode extends GraphNode<
  AgentSandboxInput,
  AgentSandboxOutput
> {
  /**
   * Resolves the sandbox configuration into the mastra sandbox resource
   * descriptor, with the ceiling-clamped timeout.
   *
   * @param {GraphNodeExecutionRequest<AgentSandboxInput>} request - Execution request.
   * @return {GraphExecutionValues} The `resource` output value.
   */
  override execute(
    request: GraphNodeExecutionRequest<AgentSandboxInput>
  ): GraphExecutionValues {
    return {
      resource: {
        type: "mastra.sandbox",
        workingDirectory: this.workingDirectory,
        isolation: this.isolation,
        timeoutMs: clampSandboxTimeoutMs(this.timeoutMs),
        input: request.inputs,
      },
    };
  }

  /** The sandbox working directory. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.sandbox.fields.workingDirectory.label",
    type: "text",
  })
  @input({ handle: "workingDirectory", userControlled: true })
  workingDirectory?: string;

  /** The sandbox isolation mode. */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.sandbox.fields.isolation.label",
    type: "select",
  })
  @input({ handle: "isolation", userControlled: true })
  isolation?: "none" | "seatbelt" | "bwrap";

  /** Command timeout in milliseconds (ceiling-clamped at execution time). */
  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.agent.sandbox.fields.timeoutMs.label",
    type: "number",
  })
  @input({ handle: "timeoutMs", userControlled: true })
  timeoutMs?: number;

  /** Output carrying the resolved mastra sandbox resource (R9). */
  @required()
  @output({ handle: "resource" })
  resource!: unknown;

  /** Connection to the agent's `sandbox` zone. */
  @connection({ category: MASTRA_AGENT_ZONE.sandbox, handle: "sandbox" })
  sandbox!: unknown;
}

/** All built-in sandbox node constructors. */
export const GRAPH_AGENT_SANDBOX_NODES = [AgentSandboxNode] as const;
