/**
 * @module as-graph/nodes/triggers/execute-workflow
 * @summary Execute Workflow trigger node declaration (DECAF-746 Trigger
 * family).
 * @description Execute Workflow — trigger for sub-workflow invocations. When a
 * parent `core.flow.executeSubWorkflow` node runs a workflow, the engine
 * starts it through this trigger kind and delivers the parent's payload under
 * the `payload` input. `execute` emits that payload as `result`, falling back
 * to the `value` input or the whole input map when no `payload` was bound.
 * The optional `schema` field documents the payload shape the sub-workflow
 * expects.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";

/** Inputs accepted by the Execute Workflow trigger. */
export type ExecuteWorkflowTriggerInput = Record<string, unknown>;

/** Outputs produced by the Execute Workflow trigger. */
export interface ExecuteWorkflowTriggerOutput {
  result: unknown;
}

/**
 * Execute Workflow trigger node: emits the sub-workflow invocation payload
 * into the workflow graph.
 */
@node("core.trigger.executeWorkflow", {
  kind: "core.trigger.executeWorkflow",
  category: "Trigger",
  color: "#3b82f6",
  icon: "ti-player-play",
  width: 96,
  height: 96,
  labels: ["trigger", "workflow", "subworkflow"],
  metadata: {
    title: "graph.node.trigger.execute_workflow.name",
    description: "graph.node.trigger.execute_workflow.description",
    trigger: {
      type: "executeWorkflow",
    },
  },
})
@model()
export class ExecuteWorkflowTriggerNode extends GraphNode<
  ExecuteWorkflowTriggerInput,
  ExecuteWorkflowTriggerOutput
> {
  /**
   * Emits the invocation payload as the trigger's output.
   *
   * @param request - The execution request carrying the `payload` input bound
   *   by the parent sub-workflow call.
   * @returns The payload (or its fallback) under `result`.
   */
  override execute(
    request: GraphNodeExecutionRequest<ExecuteWorkflowTriggerInput>
  ): GraphExecutionValues {
    const payload = request.inputs["payload"];
    return {
      result:
        payload !== undefined
          ? payload
          : request.inputs["value"] ?? request.inputs,
    };
  }

  @input({ handle: "payload" })
  payload?: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.trigger.execute_workflow.fields.schema.label",
    placeholder: "graph.node.trigger.execute_workflow.fields.schema.placeholder",
    type: "json",
  })
  @input({ handle: "schema", userControlled: true, type: "object" })
  schema?: unknown;

  @required()
  @output({ handle: "result" })
  result!: unknown;
}
