/**
 * @module as-graph/nodes/flow/execute-sub-workflow
 * @summary Execute Sub-workflow flow node declaration (DECAF-746 Flow Control
 * family).
 * @description Execute Sub-workflow — run another workflow document as a child
 * of the current run. The target document comes from the inline `workflow`
 * property when it is a valid `GraphWorkflowDocument`, otherwise it is
 * resolved by `workflowId` through the engine. The input value (the `value`
 * input, falling back to `input`) is delivered to the child under the
 * configured `inputPort` (default `value`), and each child run propagates
 * `parentRunId: context.runId` plus the caller's auth, extends the execution
 * path with a `subworkflow` segment, and (in `perItem` mode) carries the
 * current item in the metadata. `once` runs one child and returns its
 * `result` output; `perItem` runs one child per normalized input item and
 * returns the collected results as an array — array-in, array-out. Both modes
 * also expose the last child's full `outputs` and its `childRunId` for
 * correlation.
 */
import { model, required } from "@decaf-ts/decorator-validation";
import { uielement } from "@decaf-ts/ui-decorators";
import { input, node, output } from "../../../shared/graph";
import type { GraphWorkflowDocument } from "../../../shared/graph";
import { GraphNode } from "../../base";
import type {
  GraphExecutionValues,
  GraphNodeExecutionRequest,
} from "../../../engine/types";
import type { GraphExecutionContext } from "../../../engine/execution/GraphExecutionContext";
import { GraphExecutionError } from "../../../engine/errors/GraphExecutionError";
import { asGraphDataArray, isGraphDataRecord } from "../../data/support";

/** Whether the child workflow runs once or once per input item. */
export type ExecuteSubWorkflowMode = "once" | "perItem";

/** Inputs accepted by the Execute Sub-workflow node. */
export type ExecuteSubWorkflowNodeInput = Record<string, unknown>;

/** Outputs produced by the Execute Sub-workflow node. */
export interface ExecuteSubWorkflowNodeOutput {
  result: unknown;
  outputs?: GraphExecutionValues;
  childRunId?: string;
}

/**
 * Structural check for a canonical workflow document.
 *
 * @param value - The candidate value.
 * @returns `true` when the value is a record with a string `id` plus `nodes`
 *   and `edges` arrays — the minimum shape `engine.execute` accepts.
 */
function isWorkflowDocument(value: unknown): value is GraphWorkflowDocument {
  return (
    isGraphDataRecord(value) &&
    typeof value["id"] === "string" &&
    Array.isArray(value["nodes"]) &&
    Array.isArray(value["edges"])
  );
}

/**
 * Execute Sub-workflow flow node: runs a child workflow document with
 * `parentRunId` propagation and per-item fan-out.
 */
@node("core.flow.executeSubWorkflow", {
  kind: "core.flow.executeSubWorkflow",
  category: "Flow Control",
  color: "#f59e0b",
  icon: "ti-subtask",
  width: 96,
  height: 96,
  labels: ["flow", "workflow", "subworkflow"],
  metadata: {
    title: "graph.node.flow_control.execute_sub_workflow.name",
    description: "graph.node.flow_control.execute_sub_workflow.description",
  },
})
@model()
export class ExecuteSubWorkflowNode extends GraphNode<
  ExecuteSubWorkflowNodeInput,
  ExecuteSubWorkflowNodeOutput
> {
  /**
   * Resolves the child document and executes it once (`once`) or once per
   * input item (`perItem`).
   *
   * Each child run receives `parentRunId: context.runId`, a path extended with
   * a `subworkflow` segment, and the caller's auth and metadata, so cancelled
   * parents and run logs correlate with the child.
   *
   * @param request - The execution request carrying the `value` (or `input`)
   *   payload.
   * @param context - The execution context providing the engine handle and the
   *   parent run identity.
   * @returns The child result(s) under `result`, the last child's full outputs
   *   under `outputs`, and the last child's run id under `childRunId`.
   * @throws {GraphExecutionError} with code `GRAPH_ENGINE_NOT_AVAILABLE` when
   *   the context has no engine, `GRAPH_SUB_WORKFLOW_REQUIRED` when neither an
   *   inline document nor a `workflowId` is configured, and
   *   `GRAPH_SUB_WORKFLOW_NOT_FOUND` when the configured workflow cannot be
   *   resolved.
   */
  override async execute(
    request: GraphNodeExecutionRequest<ExecuteSubWorkflowNodeInput>,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    const engine = context.engine;
    if (!engine) {
      throw new GraphExecutionError(
        "Execute Sub-workflow node requires engine access",
        "GRAPH_ENGINE_NOT_AVAILABLE"
      );
    }

    const document = await this.documentOf(engine, context);
    const inputPort = this.inputPort || "value";
    const value = request.inputs["value"] ?? request.inputs["input"];

    if (this.mode === "perItem") {
      const results: unknown[] = [];
      let lastOutputs: GraphExecutionValues | undefined;
      let lastRunId: string | undefined;
      for (const item of asGraphDataArray(value)) {
        const child = await engine.execute(
          document,
          { [inputPort]: item },
          {
            parentRunId: context.runId,
            path: [...context.path, "subworkflow"],
            auth: context.auth,
            metadata: { ...context.metadata, item },
          },
          context
        );
        results.push(child.outputs["result"] ?? child.outputs);
        lastOutputs = child.outputs;
        lastRunId = child.runId;
      }
      return {
        result: results,
        outputs: lastOutputs,
        childRunId: lastRunId,
      };
    }

    const child = await engine.execute(
      document,
      { [inputPort]: value },
      {
        parentRunId: context.runId,
        path: [...context.path, "subworkflow"],
        auth: context.auth,
        metadata: context.metadata,
      },
      context
    );

    return {
      result: child.outputs["result"] ?? child.outputs,
      outputs: child.outputs,
      childRunId: child.runId,
    };
  }

  /**
   * Resolves the workflow document to execute.
   *
   * The inline `workflow` property wins when it is structurally a workflow
   * document; otherwise `workflowId` is fetched through the engine.
   *
   * @param engine - The execution engine to resolve through.
   * @param context - The execution context passed to the resolution call.
   * @returns The child workflow document.
   * @throws {GraphExecutionError} with code `GRAPH_SUB_WORKFLOW_REQUIRED` when
   *   no source is configured, or `GRAPH_SUB_WORKFLOW_NOT_FOUND` when the
   *   configured workflow cannot be resolved.
   */
  private async documentOf(
    engine: NonNullable<GraphExecutionContext["engine"]>,
    context: GraphExecutionContext
  ): Promise<GraphWorkflowDocument> {
    if (isWorkflowDocument(this.workflow)) return this.workflow;
    const workflowId = this.workflowId;
    if (!workflowId) {
      throw new GraphExecutionError(
        "Execute Sub-workflow node requires a workflow id or an inline workflow document",
        "GRAPH_SUB_WORKFLOW_REQUIRED"
      );
    }
    try {
      return await engine.getWorkflow(workflowId, context);
    } catch (error) {
      throw new GraphExecutionError(
        `Execute Sub-workflow node could not resolve workflow '${workflowId}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GRAPH_SUB_WORKFLOW_NOT_FOUND",
        { workflowId }
      );
    }
  }

  @input({ handle: "value" })
  value?: unknown;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.execute_sub_workflow.fields.workflowId.label",
    placeholder:
      "graph.node.flow_control.execute_sub_workflow.fields.workflowId.placeholder",
    type: "text",
  })
  @input({ handle: "workflowId", userControlled: true })
  workflowId?: string;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.execute_sub_workflow.fields.workflow.label",
    type: "json",
  })
  @input({ handle: "workflow", userControlled: true, type: "object" })
  workflow?: GraphWorkflowDocument;

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.execute_sub_workflow.fields.mode.label",
    type: "select",
  })
  @input({ handle: "mode", userControlled: true })
  mode: ExecuteSubWorkflowMode = "once";

  @uielement("ngx-decaf-crud-field", {
    label: "graph.node.flow_control.execute_sub_workflow.fields.inputPort.label",
    placeholder:
      "graph.node.flow_control.execute_sub_workflow.fields.inputPort.placeholder",
    type: "text",
  })
  @input({ handle: "inputPort", userControlled: true })
  inputPort?: string = "value";

  @required()
  @output({ handle: "result" })
  result!: unknown;

  @output({ handle: "outputs" })
  outputs?: GraphExecutionValues;

  @output({ handle: "childRunId" })
  childRunId?: string;
}
