/**
 * @module as-graph/execution/LocalGraphExecutionBackend
 * @summary Built-in reference graph execution backend (DECAF-50 §4.9).
 * @description The `RamAdapter` analogue of the engine abstraction seam: the
 * reference interpreter extracted verbatim from {@link GraphExecutionEngine}.
 * Given a resolved, topologically layered plan (and the canonical document for
 * translation parity), it executes nodes layer-by-layer, honours disabled-node
 * semantics, builds node inputs from routed edges/literal/expression bindings/
 * manifest defaults, validates executor outputs against the effective manifest,
 * routes values along activated data edges, and reports every transition through
 * the facade-owned {@link GraphExecutionEventSink}. All per-run state lives in
 * the facade-created {@link GraphExecutionFrame} carried by the sink; the backend
 * holds only the facade-provided collaborators (value adapter, optional code
 * sandbox evaluator, and owning engine reference).
 */
import type { Adapter, Context, MaybeContextualArg } from "@decaf-ts/core";
import type { GraphExecutionEngine } from "./GraphExecutionEngine";
import type {
  GraphExecutionErrorPayload,
  GraphExecutionEvent,
  GraphInputBinding,
  GraphJsonValue,
  GraphValueTemplate,
  GraphWorkflowDocument,
} from "../../shared/graph";
import {
  GraphExecutionEventType,
  GraphExecutionStatus,
  GraphVisualState,
  graphValueTemplateDefaultLanguage,
  isGraphValueTemplate,
} from "../../shared/graph";
import {
  GRAPH_DEFAULT_CONCURRENCY,
  GRAPH_LOCAL_EXECUTION_BACKEND,
  GRAPH_MAX_FOREACH_ITERATIONS,
  GRAPH_MAX_LOOP_ITERATIONS,
  GRAPH_WORKFLOW_BOUNDARY,
} from "../constants";
import {
  GraphBreakSignal,
  GraphExecutionError,
  GraphRunCancelledError,
} from "../errors";
import type {
  GraphExecutionLimits,
  GraphExecutionOptions,
  GraphExecutionResult,
  GraphExecutionValues,
  GraphNodeExecutionRequest,
  GraphNodeExecutionResult,
  GraphResolvedCredentials,
} from "../types";
import type { GraphExecutionPlan } from "../planning/GraphExecutionPlan";
import type { GraphExecutionPlanNode } from "../planning/GraphExecutionPlanNode";
import type { GraphExecutionPlanEdge } from "../planning/GraphExecutionPlanEdge";
import {
  GraphParameterValidator,
  isGraphCredentialReferenceLike,
} from "../validation/GraphParameterValidator";
import { createGraphValueRepository } from "../store/GraphValueRepository";
import type { GraphCachedValue } from "../store/GraphCachedValue";
import { GraphPinningService } from "../pinning/GraphPinningService";
import { GraphPinningPolicy } from "../pinning/GraphPinningPolicy";
import { GraphPinningDependencyResolver } from "../pinning/GraphPinningDependencyResolver";
import { GraphExecutionContext } from "./GraphExecutionContext";
import type { GraphExecutionFrame } from "./GraphExecutionFrame";
import { buildGraphExecutionResult } from "./GraphExecutionResult";
import type { CodeSandboxEvaluator } from "./CodeSandboxEvaluator";
import type {
  GraphBackendCapabilities,
  GraphBackendExecutionRequest,
  GraphBackendWorkflowStore,
  GraphBackendWorkflowSummary,
  GraphExecutionBackend,
  GraphFrameAwareEventSink,
} from "./GraphExecutionBackend";
import { GraphExecutionBackendRegistry } from "./GraphExecutionBackendRegistry";

/**
 * Compiles a `{{ ... }}` text template into a JavaScript template literal so
 * the pluggable code sandbox evaluator can resolve its placeholders against
 * the same `$input`/`$vars`/`$item` bindings used by expression bindings.
 *
 * @param template - The persisted template body.
 * @returns A backtick-quoted template literal expression.
 */
function graphTemplateToExpression(template: string): string {
  const escaped = template.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  const interpolated = escaped.replace(
    /\{\{\s*([\s\S]*?)\s*\}\}/g,
    (_match, expression: string) => `\${${expression}}`
  );
  return `\`${interpolated}\``;
}

/**
 * Configuration for the {@link LocalGraphExecutionBackend}.
 */
export interface LocalGraphExecutionBackendConfig
  extends Record<string, unknown> {
  /** Decaf adapter backing cached/pinned value persistence. */
  valueAdapter: Adapter<any, any, any, any>;
  /** Optional pluggable code sandbox evaluator. */
  codeSandboxEvaluator?: CodeSandboxEvaluator;
  /**
   * Optional workflow catalogue port backing the listing/lookup capability.
   * Hosts pass their `GraphWorkflowService` here; when absent the backend
   * reports the capability as `not_supported` instead of returning an empty list.
   */
  workflowStore?: GraphBackendWorkflowStore;
  /** The facade engine, exposed to node contexts. */
  engine: GraphExecutionEngine;
}

/**
 * Built-in reference graph execution backend. Registers itself under
 * {@link GRAPH_LOCAL_EXECUTION_BACKEND} on construction.
 */
export class LocalGraphExecutionBackend
  implements GraphExecutionBackend<LocalGraphExecutionBackendConfig>
{
  /** This backend executes locally, in-process. */
  readonly local = true;

  /**
   * This backend executes code-mode surfaces host-side through the
   * facade-owned `CodeSandboxEvaluator` (SAA-193 C1).
   */
  readonly codeMode = "hostSide" as const;

  private valueAdapter!: Adapter<any, any, any, any>;
  private codeSandboxEvaluator?: CodeSandboxEvaluator;
  private workflowStore?: GraphBackendWorkflowStore;
  private engine!: GraphExecutionEngine;

  constructor() {
    GraphExecutionBackendRegistry.register(
      GRAPH_LOCAL_EXECUTION_BACKEND,
      this
    );
  }

  /**
   * Resolves the backend's runtime collaborators. Called by the facade during
   * `GraphExecutionEngine.initialize`.
   *
   * @param config - The facade-provided collaborators.
   */
  async initialize(
    config: LocalGraphExecutionBackendConfig
  ): Promise<void> {
    this.valueAdapter = config.valueAdapter;
    this.codeSandboxEvaluator = config.codeSandboxEvaluator;
    this.workflowStore = config.workflowStore;
    this.engine = config.engine;
  }

  /**
   * Effective capability metadata: code-mode is host-side and workflow
   * listing/lookup is supported exactly when a catalogue port is wired in.
   */
  get capabilities(): GraphBackendCapabilities {
    const status = this.workflowStore ? "supported" : "not_supported";
    return {
      codeMode: this.codeMode,
      workflows: { list: status, get: status },
    };
  }

  /**
   * Lists the workflows visible to the requesting principal through the wired
   * `GraphWorkflowStore` port.
   *
   * @param args - Optional decaf contextual arguments forwarded to the store.
   * @returns Workflow summaries, newest first when the store orders them.
   * @throws {GraphExecutionError} when no workflow store is wired in.
   */
  async listWorkflows(
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphBackendWorkflowSummary[]> {
    const store = this.workflowStore;
    if (!store) {
      throw new GraphExecutionError(
        "LocalGraphExecutionBackend has no workflowStore configured; workflow listing is not supported",
        "GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED"
      );
    }
    const records = await store.listWorkflows(...args);
    return records.map((record) => ({
      id: record.workflowId,
      ...(record.name !== undefined ? { name: record.name } : {}),
      ...(record.updatedAt !== undefined && record.updatedAt !== null
        ? { updatedAt: record.updatedAt }
        : {}),
    }));
  }

  /**
   * Reads a single canonical workflow document through the wired
   * `GraphWorkflowStore` port.
   *
   * @param workflowId - The workflow id to read.
   * @param args - Optional decaf contextual arguments forwarded to the store.
   * @returns The canonical workflow document.
   * @throws {GraphExecutionError} when no workflow store is wired in.
   */
  async getWorkflow(
    workflowId: string,
    ...args: MaybeContextualArg<Context>
  ): Promise<GraphWorkflowDocument> {
    const store = this.workflowStore;
    if (!store) {
      throw new GraphExecutionError(
        "LocalGraphExecutionBackend has no workflowStore configured; workflow lookup is not supported",
        "GRAPH_BACKEND_WORKFLOWS_NOT_SUPPORTED"
      );
    }
    return await store.getDocument(workflowId, ...args);
  }

  /**
   * Executes a validated/resolved workflow's plan against the facade-owned
   * frame carried by the request's event sink.
   *
   * @param request - The execution request.
   * @returns The complete execution result.
   * @throws {GraphExecutionError} when the request's sink is not the
   *   facade-created frame-aware sink.
   */
  async execute(
    request: GraphBackendExecutionRequest
  ): Promise<GraphExecutionResult> {
    const { document, plan, inputs, options: opts, events } = request;
    const sink = events as GraphFrameAwareEventSink;
    const frame = sink.frame;
    if (!frame) {
      throw new GraphExecutionError(
        "LocalGraphExecutionBackend requires the frame-bound event sink created by GraphExecutionEngine",
        "GRAPH_EXECUTION_FRAME_MISSING"
      );
    }
    const valueStore = frame.valueStore;
    const runId = frame.runId;
    const path = opts.path ?? [];
    const emitFn = async (
      partial: Partial<GraphExecutionEvent>
    ): Promise<void> => {
      await sink.emit(partial);
    };

    try {
      for (const layer of plan.layers) {
        this.assertNotAborted(opts);
        await this.executeLayer(frame, plan, layer.nodes, opts, emitFn);
      }
      this.assertNotAborted(opts);

      const firstFailure = [...frame.nodeResults.values()].find(
        (result) => result.status === GraphExecutionStatus.FAILED
      );
      if (firstFailure?.error) {
        throw new GraphExecutionError(
          firstFailure.error.message,
          firstFailure.error.code ?? "GRAPH_EXECUTION_ERROR",
          firstFailure.error.details
        );
      }

      frame.finish();

      await sink.emit({
        type: GraphExecutionEventType.WORKFLOW_COMPLETED,
        runId,
        parentRunId: opts.parentRunId,
        workflowId: plan.workflowId,
        path,
        status: GraphExecutionStatus.SUCCEEDED,
        payload: { outputs: valueStore.getWorkflowValues() },
      });

      return buildGraphExecutionResult(
        frame,
        document,
        inputs,
        GraphExecutionStatus.SUCCEEDED,
        opts.metadata
      );
    } catch (error) {
      // A cooperative `GraphBreakSignal` is loop-control flow, not a workflow
      // failure: propagate it unchanged so the enclosing loop executor can stop
      // iterating instead of seeing a failed child run.
      if (error instanceof GraphBreakSignal) {
        frame.finish();
        throw error;
      }
      frame.finish();
      const errorPayload = this.toErrorPayload(error);

      if (
        error instanceof GraphRunCancelledError ||
        opts.abortSignal?.aborted === true
      ) {
        await sink.emit({
          type: GraphExecutionEventType.WORKFLOW_CANCELLED,
          runId,
          parentRunId: opts.parentRunId,
          workflowId: plan.workflowId,
          path,
          status: GraphExecutionStatus.CANCELLED,
          error: errorPayload,
        });

        return buildGraphExecutionResult(
          frame,
          document,
          inputs,
          GraphExecutionStatus.CANCELLED,
          opts.metadata
        );
      }

      await sink.emit({
        type: GraphExecutionEventType.WORKFLOW_FAILED,
        runId,
        parentRunId: opts.parentRunId,
        workflowId: plan.workflowId,
        path,
        status: GraphExecutionStatus.FAILED,
        error: errorPayload,
      });

      return buildGraphExecutionResult(
        frame,
        document,
        inputs,
        GraphExecutionStatus.FAILED,
        opts.metadata
      );
    }
  }

  /**
   * Executes a layer of nodes with the configured concurrency.
   */
  private async executeLayer(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    nodes: GraphExecutionPlanNode[],
    opts: GraphExecutionOptions,
    emitFn: (event: Partial<GraphExecutionEvent>) => Promise<void>
  ): Promise<void> {
    const concurrency = Math.max(
      1,
      opts.concurrency ?? GRAPH_DEFAULT_CONCURRENCY
    );
    const queue = [...nodes];

    while (queue.length > 0) {
      const batch = queue.splice(0, concurrency);
      await Promise.all(
        batch.map((node) => this.executeNode(frame, plan, node, opts, emitFn))
      );
    }
  }

  /**
   * Executes a single node, honouring disabled-node semantics (§4.9).
   */
  private async executeNode(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    opts: GraphExecutionOptions,
    emitFn: (event: Partial<GraphExecutionEvent>) => Promise<void>
  ): Promise<void> {
    this.assertNotAborted(opts);
    if (!this.isNodeActivated(frame, plan, planNode)) {
      await this.skipInactiveNode(frame, plan, planNode, opts, emitFn);
      return;
    }
    if (planNode.instance.disabled === true) {
      await this.executeDisabledNode(frame, plan, planNode, opts, emitFn);
      return;
    }

    const startedAt = new Date();
    const nodePath = [...(opts.path ?? []), planNode.id];

    await emitFn({
      type: GraphExecutionEventType.NODE_STARTED,
      runId: frame.runId,
      workflowId: plan.workflowId,
      nodeId: planNode.id,
      path: nodePath,
      status: GraphExecutionStatus.RUNNING,
    });
    this.emitNodeStateChanged(
      frame,
      plan,
      planNode,
      nodePath,
      GraphVisualState.RUNNING,
      GraphExecutionStatus.RUNNING,
      emitFn
    );

    const inputs = await this.resolveNodeInputs(frame, plan, planNode, opts);

    // Cache-hit: check for a pinned value before executing the node
    if (opts.usePinnedValues) {
      const cached = await this.tryPinnedValue(frame, plan, planNode, inputs);
      if (cached) {
        frame.valueStore.setNodeOutputs(planNode.id, cached.outputs);
        this.routeOutgoingEdges(
          frame,
          plan,
          planNode,
          cached.outputs,
          emitFn
        );

        const finishedAt = new Date();
        const result: GraphNodeExecutionResult = {
          nodeId: planNode.id,
          status: GraphExecutionStatus.CACHED,
          inputs,
          outputs: cached.outputs,
          startedAt,
          finishedAt,
          fromCache: true,
          pinned: true,
          events: [],
        };
        frame.recordNodeResult(result);

        await emitFn({
          type: GraphExecutionEventType.NODE_CACHE_HIT,
          runId: frame.runId,
          workflowId: plan.workflowId,
          nodeId: planNode.id,
          path: nodePath,
          status: GraphExecutionStatus.CACHED,
          payload: { outputs: cached.outputs },
        });

        await emitFn({
          type: GraphExecutionEventType.NODE_COMPLETED,
          runId: frame.runId,
          workflowId: plan.workflowId,
          nodeId: planNode.id,
          path: nodePath,
          status: GraphExecutionStatus.SUCCEEDED,
          payload: { outputs: cached.outputs, fromCache: true },
        });
        this.emitNodeStateChanged(
          frame,
          plan,
          planNode,
          nodePath,
          GraphVisualState.SUCCEEDED,
          GraphExecutionStatus.SUCCEEDED,
          emitFn
        );
        return;
      }
    }

    try {
      const context = new GraphExecutionContext(
        frame.runId,
        opts.parentRunId,
        plan.workflowId,
        plan.resolved.document,
        planNode.instance,
        planNode.manifest,
        nodePath,
        emitFn,
        opts.metadata,
        this.engine,
        opts.abortSignal,
        this.executionLimits(opts)
      );

      const parameters = await this.resolveNodeParameters(
        planNode,
        inputs,
        opts
      );

      const request: GraphNodeExecutionRequest = {
        nodeId: planNode.id,
        kind: planNode.kind,
        inputs,
        parameters,
        credentials: this.collectCredentials(planNode),
        metadata: planNode.instance.metadata,
      };

      const rawOutputs = await this.invokeExecutor(planNode, request, context);
      const outputs = this.validateNodeOutputs(planNode, rawOutputs ?? {});

      frame.valueStore.setNodeOutputs(planNode.id, outputs);
      this.routeOutgoingEdges(frame, plan, planNode, outputs, emitFn);

      const finishedAt = new Date();
      const result: GraphNodeExecutionResult = {
        nodeId: planNode.id,
        status: GraphExecutionStatus.SUCCEEDED,
        inputs,
        outputs,
        startedAt,
        finishedAt,
        events: [],
      };
      frame.recordNodeResult(result);

      await emitFn({
        type: GraphExecutionEventType.NODE_COMPLETED,
        runId: frame.runId,
        workflowId: plan.workflowId,
        nodeId: planNode.id,
        path: nodePath,
        status: GraphExecutionStatus.SUCCEEDED,
        payload: { outputs },
      });
      this.emitNodeStateChanged(
        frame,
        plan,
        planNode,
        nodePath,
        GraphVisualState.SUCCEEDED,
        GraphExecutionStatus.SUCCEEDED,
        emitFn
      );
    } catch (error) {
      // Loop-control flow is not a node failure: rethrow the break token so
      // the enclosing loop executor observes it rather than a FAILED node.
      if (error instanceof GraphBreakSignal) throw error;
      const finishedAt = new Date();
      const errorPayload = this.toErrorPayload(error);
      const result: GraphNodeExecutionResult = {
        nodeId: planNode.id,
        status: GraphExecutionStatus.FAILED,
        inputs,
        error: errorPayload,
        startedAt,
        finishedAt,
        events: [],
      };
      frame.recordNodeResult(result);

      await emitFn({
        type: GraphExecutionEventType.NODE_FAILED,
        runId: frame.runId,
        workflowId: plan.workflowId,
        nodeId: planNode.id,
        path: nodePath,
        status: GraphExecutionStatus.FAILED,
        error: errorPayload,
      });
      this.emitNodeStateChanged(
        frame,
        plan,
        planNode,
        nodePath,
        GraphVisualState.FAILED,
        GraphExecutionStatus.FAILED,
        emitFn
      );

      if (opts.failFast ?? true) throw error;
    }
  }

  /**
   * Resolves whether a plan node is activated for execution under the
   * DECAF-50 §4.9 branch semantics. A node with no incoming data edges is
   * a root/source node and always runs. A node fed by one or more data
   * edges runs only when at least one of those edges was activated by a
   * routed upstream output port — a branch the upstream switch (or any
   * partial-output node) did not select leaves its downstream edges
   * unactivated, so the branch is never executed. Workflow-boundary edges
   * are active from the start because workflow inputs are seeded before
   * execution begins.
   */
  private isNodeActivated(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode
  ): boolean {
    const incoming = (plan.incomingByNode.get(planNode.id) ?? []).filter(
      (edge) => edge.type === "data"
    );
    if (incoming.length === 0) return true;
    return incoming.some(
      (edge) =>
        edge.sourceNodeId === GRAPH_WORKFLOW_BOUNDARY ||
        frame.isDataEdgeActive(edge.id)
    );
  }

  /**
   * Skips a node whose incoming data edges were all left unactivated by an
   * upstream branch selection. The node is not executed and its outputs are
   * never routed or collected into workflow outputs (DECAF-50 §4.9).
   */
  private async skipInactiveNode(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    opts: GraphExecutionOptions,
    emitFn: (event: Partial<GraphExecutionEvent>) => Promise<void>
  ): Promise<void> {
    const startedAt = new Date();
    const nodePath = [...(opts.path ?? []), planNode.id];

    await emitFn({
      type: GraphExecutionEventType.NODE_SKIPPED,
      runId: frame.runId,
      workflowId: plan.workflowId,
      nodeId: planNode.id,
      path: nodePath,
      status: GraphExecutionStatus.SKIPPED,
      payload: { reason: "branchNotSelected" },
    });

    const result: GraphNodeExecutionResult = {
      nodeId: planNode.id,
      status: GraphExecutionStatus.SKIPPED,
      inputs: {},
      startedAt,
      finishedAt: new Date(),
      events: [],
    };
    frame.recordNodeResult(result);
    this.emitNodeStateChanged(
      frame,
      plan,
      planNode,
      nodePath,
      GraphVisualState.SKIPPED,
      GraphExecutionStatus.SKIPPED,
      emitFn
    );
  }

  /**
   * Applies the explicit disabled-node semantics (§4.9):
   * `skip`, `passThroughFirstInput`, or `emitDefaults`, resolved from the
   * instance metadata, document settings, and the default.
   */
  private async executeDisabledNode(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    opts: GraphExecutionOptions,
    emitFn: (event: Partial<GraphExecutionEvent>) => Promise<void>
  ): Promise<void> {
    const startedAt = new Date();
    const nodePath = [...(opts.path ?? []), planNode.id];
    const behavior = GraphParameterValidator.disabledBehaviorOf(
      planNode.instance,
      plan.resolved.document.settings
    );

    await emitFn({
      type: GraphExecutionEventType.NODE_SKIPPED,
      runId: frame.runId,
      workflowId: plan.workflowId,
      nodeId: planNode.id,
      path: nodePath,
      status: GraphExecutionStatus.SKIPPED,
      payload: { disabled: true, behavior },
    });

    if (behavior === "skip") {
      const result: GraphNodeExecutionResult = {
        nodeId: planNode.id,
        status: GraphExecutionStatus.SKIPPED,
        inputs: {},
        startedAt,
        finishedAt: new Date(),
        events: [],
      };
      frame.recordNodeResult(result);
      this.emitNodeStateChanged(
        frame,
        plan,
        planNode,
        nodePath,
        GraphVisualState.SKIPPED,
        GraphExecutionStatus.SKIPPED,
        emitFn
      );
      return;
    }

    const inputs = await this.resolveNodeInputs(frame, plan, planNode, opts);
    let outputs: GraphExecutionValues;

    if (behavior === "passThroughFirstInput") {
      const firstIncoming = (plan.incomingByNode.get(planNode.id) ?? []).find(
        (edge) => edge.type === "data"
      );
      const firstOutput = planNode.manifest.outputs[0]?.id ?? "value";
      const value = firstIncoming
        ? frame.valueStore.getPort(
            firstIncoming.sourceNodeId,
            firstIncoming.sourcePort
          )
        : Object.values(inputs)[0];
      outputs = { [firstOutput]: value };
    } else {
      // emitDefaults — every declared output port is emitted with its
      // declared default (absent a declared default, undefined).
      outputs = {};
      for (const port of planNode.manifest.outputs) {
        outputs[port.id] = port.metadata?.["defaultValue"];
      }
    }

    frame.valueStore.setNodeOutputs(planNode.id, outputs);
    this.routeOutgoingEdges(frame, plan, planNode, outputs, emitFn);

    const result: GraphNodeExecutionResult = {
      nodeId: planNode.id,
      status: GraphExecutionStatus.SUCCEEDED,
      inputs,
      outputs,
      startedAt,
      finishedAt: new Date(),
      events: [],
    };
    frame.recordNodeResult(result);
    this.emitNodeStateChanged(
      frame,
      plan,
      planNode,
      nodePath,
      GraphVisualState.SUCCEEDED,
      GraphExecutionStatus.SUCCEEDED,
      emitFn
    );
  }

  /**
   * Invokes the node's catalogue-resolved executor (§4.9 request contract,
   * post-cutover: every executor receives the full request with
   * configuration and input data separated).
   */
  private async invokeExecutor(
    planNode: GraphExecutionPlanNode,
    request: GraphNodeExecutionRequest,
    context: GraphExecutionContext
  ): Promise<GraphExecutionValues> {
    return await planNode.executor.execute(request, context);
  }

  /**
   * Validates executor outputs against the effective output manifest
   * (§4.9): unknown outputs are rejected by default; missing required
   * outputs fail the node. Lenient transition manifests (legacy
   * executor-only registrations) are exempt until cutover.
   */
  private validateNodeOutputs(
    planNode: GraphExecutionPlanNode,
    outputs: GraphExecutionValues
  ): GraphExecutionValues {
    const manifest = planNode.manifest;
    if (manifest.policies?.allowUnknownOutputs === true) {
      return outputs;
    }

    const declaredOutputs = new Set(manifest.outputs.map((port) => port.id));
    const unknownOutputs = Object.keys(outputs).filter(
      (key) => !declaredOutputs.has(key)
    );
    if (unknownOutputs.length > 0) {
      throw new GraphExecutionError(
        `Node '${planNode.id}' of kind '${planNode.kind}' produced unknown output(s): ${unknownOutputs.join(", ")}`,
        "GRAPH_OUTPUT_VALIDATION_FAILED",
        { nodeId: planNode.id, unknownOutputs }
      );
    }

    const missingRequired = manifest.outputs
      .filter((port) => port.required === true && !(port.id in outputs))
      .map((port) => port.id);
    if (missingRequired.length > 0) {
      throw new GraphExecutionError(
        `Node '${planNode.id}' of kind '${planNode.kind}' did not produce required output(s): ${missingRequired.join(", ")}`,
        "GRAPH_OUTPUT_VALIDATION_FAILED",
        { nodeId: planNode.id, missingRequired }
      );
    }

    return outputs;
  }

  /**
   * Collects the resolved credential references for a node: credential-type
   * parameter values plus the `credentials` record in instance metadata.
   * Documents carry references only — secret material never enters requests.
   */
  private collectCredentials(
    planNode: GraphExecutionPlanNode
  ): GraphResolvedCredentials {
    const credentials: GraphResolvedCredentials = {};
    for (const parameter of planNode.manifest.parameters) {
      if (parameter.type !== "credential") continue;
      const value: unknown = (planNode.instance.parameters ?? {})[
        parameter.id
      ];
      if (typeof value === "string" && value.length > 0) {
        credentials[parameter.id] = {
          credentialId: value,
          credentialType: parameter.credentialType ?? "",
        };
      } else if (isGraphCredentialReferenceLike(value)) {
        credentials[parameter.id] = {
          credentialId: value.credentialId,
          credentialType: value.credentialType,
        };
      }
    }
    const extra = (planNode.instance.metadata ?? {})["credentials"];
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      for (const [key, raw] of Object.entries(
        extra as Record<string, GraphJsonValue>
      )) {
        const value: unknown = raw;
        if (typeof value === "string" && value.length > 0) {
          credentials[key] = { credentialId: value, credentialType: "" };
        } else if (isGraphCredentialReferenceLike(value)) {
          credentials[key] = {
            credentialId: value.credentialId,
            credentialType: value.credentialType,
          };
        }
      }
    }
    return credentials;
  }

  /**
   * Resolves a node's input values from routed data edges, literal bindings,
   * allowed expression bindings, and manifest port defaults (§4.9).
   *
   * When multiple edges target the same port, their values are spread into the
   * top-level inputs keyed by each edge's `sourcePort`. This allows multiple
   * workflow input badges to connect to a single port (e.g. the Code node's
   * `data` port) and have all values accessible directly as
   * `$input.{sourcePort}` (e.g. `$input.count`, `$input.text`).
   */
  private async resolveNodeInputs(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    opts: GraphExecutionOptions
  ): Promise<GraphExecutionValues> {
    const inputs: GraphExecutionValues = {};
    const incoming = (plan.incomingByNode.get(planNode.id) ?? []).filter(
      (edge) => edge.type === "data"
    );

    const edgesByTarget = new Map<string, typeof incoming>();
    for (const edge of incoming) {
      const list = edgesByTarget.get(edge.targetPort) ?? [];
      list.push(edge);
      edgesByTarget.set(edge.targetPort, list);
    }

    for (const [targetPort, edges] of edgesByTarget) {
      if (edges.length === 1) {
        inputs[targetPort] = frame.valueStore.getPort(
          edges[0].sourceNodeId,
          edges[0].sourcePort
        );
      } else {
        let definedValue: unknown;
        let hasDefined = false;
        for (const edge of edges) {
          const value = frame.valueStore.getPort(
            edge.sourceNodeId,
            edge.sourcePort
          );
          inputs[edge.sourcePort] = value;
          if (value !== undefined) {
            definedValue = value;
            hasDefined = true;
          }
        }
        // Branch merges route several mutually-exclusive outputs onto the same
        // target port (e.g. an if/switch branch). The port-keyed map above
        // preserves distinct source ports, but the target port must also receive
        // the single defined branch value so the node reads its own port.
        if (hasDefined && inputs[targetPort] === undefined) {
          inputs[targetPort] = definedValue;
        }
      }
    }

    // Literal bindings, expression bindings, and manifest defaults.
    const bindings = planNode.instance.inputBindings ?? {};
    for (const port of planNode.manifest.inputs) {
      const binding: GraphInputBinding | undefined = bindings[port.id];
      if (binding?.mode === "literal") {
        inputs[port.id] = binding.value;
      } else if (binding?.mode === "expression") {
        inputs[port.id] = await this.evaluateExpressionBinding(
          planNode,
          binding.expression,
          inputs,
          opts
        );
      } else if (inputs[port.id] === undefined) {
        const defaultValue = port.metadata?.["defaultValue"];
        if (defaultValue !== undefined) {
          inputs[port.id] = defaultValue;
        }
      }
    }

    return inputs;
  }

  /**
   * Resolves a node's persisted parameters at execution time, evaluating any
   * `GraphValueTemplate` user property through the code-evaluator VM and
   * leaving straight literal values unchanged.
   */
  private async resolveNodeParameters(
    planNode: GraphExecutionPlanNode,
    inputs: GraphExecutionValues,
    opts: GraphExecutionOptions
  ): Promise<Record<string, GraphJsonValue>> {
    const parameters = planNode.instance.parameters ?? {};
    const resolved: Record<string, GraphJsonValue> = {};
    for (const [key, value] of Object.entries(parameters)) {
      resolved[key] = isGraphValueTemplate(value)
        ? await this.evaluateValueTemplate(value, planNode, inputs, opts)
        : value;
    }
    return resolved;
  }

  /**
   * Evaluates a persisted `GraphValueTemplate` with the pluggable
   * {@link CodeSandboxEvaluator} (DECAF-32 §22.4) — no new evaluator.
   * `expression` mode evaluates the body directly; `template` mode compiles its
   * `{{ ... }}` placeholders into a JavaScript template literal evaluated in
   * the same sandbox, so both modes share the code-evaluator VM.
   */
  private async evaluateValueTemplate(
    template: GraphValueTemplate,
    planNode: GraphExecutionPlanNode,
    inputs: GraphExecutionValues,
    opts: GraphExecutionOptions
  ): Promise<GraphJsonValue> {
    const evaluator = this.codeSandboxEvaluator;
    if (!evaluator) {
      throw new GraphExecutionError(
        `Value template on node '${planNode.id}' requires a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator`,
        "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
        { nodeId: planNode.id }
      );
    }
    const language =
      template.language ?? graphValueTemplateDefaultLanguage(template.mode);
    const code =
      template.mode === "template"
        ? graphTemplateToExpression(template.expression)
        : template.expression;
    const md = opts.metadata as Record<string, unknown> | undefined;
    const result = await evaluator.evaluate({
      code,
      language: language === "typescript" ? "typescript" : "javascript",
      input: inputs,
      vars: (md?.vars as Record<string, unknown> | undefined) ?? undefined,
      item: md?.item,
      index: md?.index as number | undefined,
      abortSignal: opts.abortSignal,
    });
    return result as GraphJsonValue;
  }

  /**
   * Evaluates an expression binding with the EXISTING allowed-expression
   * machinery only (the pluggable {@link CodeSandboxEvaluator}, DECAF-32
   * §22.4) — no new evaluator. The expression sees the already-routed input
   * values as `$input` and the run metadata as context.
   */
  private async evaluateExpressionBinding(
    planNode: GraphExecutionPlanNode,
    expression: string,
    inputs: GraphExecutionValues,
    opts: GraphExecutionOptions
  ): Promise<unknown> {
    const evaluator = this.codeSandboxEvaluator;
    if (!evaluator) {
      throw new GraphExecutionError(
        `Expression binding on node '${planNode.id}' requires a CodeSandboxEvaluator to be registered in GraphExecutionEngineConfig.codeSandboxEvaluator`,
        "GRAPH_CODE_SANDBOX_NOT_CONFIGURED",
        { nodeId: planNode.id, expression }
      );
    }
    const md = opts.metadata as Record<string, unknown> | undefined;
    return await evaluator.evaluate({
      code: expression,
      language: "javascript",
      input: inputs,
      vars: (md?.vars as Record<string, unknown> | undefined) ?? undefined,
      item: md?.item,
      index: md?.index as number | undefined,
      abortSignal: opts.abortSignal,
    });
  }

  /**
   * Attempts to read a pinned value for the node. Returns the cached outputs
   * when a valid pinned value exists, or `undefined` to proceed with normal
   * execution.
   */
  private async tryPinnedValue(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    inputs: GraphExecutionValues
  ): Promise<GraphCachedValue | undefined> {
    const policy = new GraphPinningPolicy();
    if (!policy.shouldUsePinnedValue(planNode)) return undefined;

    const service = this.createPinningService(frame);
    const depFingerprints = this.computeDependencyFingerprints(
      frame,
      plan,
      planNode.id
    );
    return service.readPinnedValue(
      plan.workflowId,
      planNode,
      inputs,
      depFingerprints
    );
  }

  /**
   * Recursively computes fingerprints for all upstream dependencies of a node
   * using the results already accumulated in the frame.
   */
  private computeDependencyFingerprints(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    nodeId: string
  ): Record<string, string> {
    const service = this.createPinningService(frame);
    const depResolver = new GraphPinningDependencyResolver();
    const deps = depResolver.getDependencies(plan, nodeId);
    const fingerprints: Record<string, string> = {};
    for (const dep of deps) {
      const node = plan.nodes.find((n) => n.id === dep);
      if (node) {
        const depResult = frame.nodeResults.get(dep);
        const inputs = depResult?.inputs ?? {};
        const nestedDeps = this.computeDependencyFingerprints(
          frame,
          plan,
          dep
        );
        fingerprints[dep] = service.computeFingerprint(
          plan.workflowId,
          node,
          inputs,
          nestedDeps
        );
      }
    }
    return fingerprints;
  }

  /**
   * Routes a node's outputs to downstream inputs and workflow outputs along
   * data edges (connection edges are structural and never route values).
   *
   * An edge is traversed only when the source node actually emitted the
   * edge's `sourcePort` (DECAF-50 §4.9 branch semantics). A node that
   * emitted a subset of its declared outputs — e.g. a switch that selected
   * one case — therefore activates only the downstream branch edges of the
   * emitted ports; unselected branch edges are left unactivated, so their
   * downstream nodes are skipped and never contribute to workflow outputs.
   * Emitting an output port explicitly with `undefined` still counts as
   * activated (the port was produced by the executor).
   */
  private routeOutgoingEdges(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    outputs: GraphExecutionValues,
    emitFn: (event: Partial<GraphExecutionEvent>) => Promise<void>
  ): void {
    const outgoing = (plan.outgoingByNode.get(planNode.id) ?? []).filter(
      (edge) => edge.type === "data"
    );
    for (const edge of outgoing) {
      if (!Object.prototype.hasOwnProperty.call(outputs, edge.sourcePort)) {
        // The source node did not emit this output port: the edge's branch
        // was not selected, so no value is routed.
        continue;
      }
      const value = outputs[edge.sourcePort];
      frame.activateDataEdge(edge.id);
      if (edge.targetNodeId === GRAPH_WORKFLOW_BOUNDARY) {
        frame.valueStore.setWorkflowOutput(edge.targetPort, value);
      }
      this.emitEdgeStateChanged(
        frame,
        plan,
        planNode,
        edge,
        GraphVisualState.SUCCEEDED,
        GraphExecutionStatus.SUCCEEDED,
        emitFn
      );
      emitFn({
        type: GraphExecutionEventType.EDGE_VALUE_ROUTED,
        runId: frame.runId,
        workflowId: plan.workflowId,
        edgeId: edge.id,
        nodeId: planNode.id,
        path: [],
        payload: { edge, value },
      }).catch(() => {
        // observer failures must not crash
      });
    }
  }

  /**
   * Emits a `NODE_STATE_CHANGED` event (DECAF-48 §4.4) carrying the given
   * visual state for the node. Rides the existing Observable pipeline; no
   * second out-of-band channel.
   */
  private emitNodeStateChanged(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    nodePath: string[],
    state: GraphVisualState,
    status: GraphExecutionStatus | undefined,
    emitFn: (event: Partial<GraphExecutionEvent>) => Promise<void>
  ): void {
    emitFn({
      type: GraphExecutionEventType.NODE_STATE_CHANGED,
      runId: frame.runId,
      workflowId: plan.workflowId,
      nodeId: planNode.id,
      path: nodePath,
      status,
      payload: {
        nodeId: planNode.id,
        state,
        runId: frame.runId,
        workflowId: plan.workflowId,
        status,
      },
    }).catch(() => {
      // observer failures must not crash execution
    });
  }

  /**
   * Emits an `EDGE_STATE_CHANGED` event (DECAF-48 §4.4) carrying the given
   * visual state for a routed edge.
   */
  private emitEdgeStateChanged(
    frame: GraphExecutionFrame,
    plan: GraphExecutionPlan,
    planNode: GraphExecutionPlanNode,
    edge: GraphExecutionPlanEdge,
    state: GraphVisualState,
    status: GraphExecutionStatus | undefined,
    emitFn: (event: Partial<GraphExecutionEvent>) => Promise<void>
  ): void {
    emitFn({
      type: GraphExecutionEventType.EDGE_STATE_CHANGED,
      runId: frame.runId,
      workflowId: plan.workflowId,
      edgeId: edge.id,
      nodeId: planNode.id,
      path: [],
      status,
      payload: {
        edgeId: edge.id,
        state,
        runId: frame.runId,
        workflowId: plan.workflowId,
        nodeId: planNode.id,
        status,
      },
    }).catch(() => {
      // observer failures must not crash execution
    });
  }

  /**
   * Creates a {@link GraphPinningService} backed by the run's value store
   * adapter.
   */
  private createPinningService(
    frame: GraphExecutionFrame
  ): GraphPinningService {
    const adapter = frame.valueStore.getAdapter() ?? this.valueAdapter;
    const store = createGraphValueRepository(adapter);
    return new GraphPinningService(
      store,
      new GraphPinningPolicy(),
      new GraphPinningDependencyResolver()
    );
  }

  /**
   * Resolves the effective loop-iteration ceilings for a run. A node-level
   * `maxIterations` can never exceed these; loop executors read them from the
   * node context.
   */
  private executionLimits(
    opts: GraphExecutionOptions
  ): GraphExecutionLimits {
    return {
      maxLoopIterations:
        opts.maxLoopIterations ?? GRAPH_MAX_LOOP_ITERATIONS,
      maxForeachIterations:
        opts.maxForeachIterations ?? GRAPH_MAX_FOREACH_ITERATIONS,
    };
  }

  private assertNotAborted(opts: GraphExecutionOptions): void {
    if (opts.abortSignal?.aborted === true) {
      throw new GraphRunCancelledError(opts.runId ?? "unknown");
    }
  }

  /**
   * Converts an error into a serialized payload.
   */
  private toErrorPayload(error: unknown): GraphExecutionErrorPayload {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code:
          (error as any).graphCode ??
          (typeof (error as any).code === "number"
            ? String((error as any).code)
            : (error as any).code),
      };
    }
    return { name: "UnknownError", message: String(error) };
  }
}
