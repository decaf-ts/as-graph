/**
 * @module as-graph/mastra/MastraWorkflowCompiler
 * @summary Compiles canonical workflow documents into Mastra workflows
 * (SAA-196, SAA-1545 §4).
 * @description The compiler derives execution order from the validated graph
 * topology, not from document node order: dependency layers come from the
 * canonical planner (or the same shared edge/cycle rules when no plan is
 * supplied). Every layer becomes a native `workflow.parallel(...)` group when it
 * holds more than one node, and a `.then(...)` barrier otherwise. A routing map
 * before each layer resolves input values by graph port identity, gates nodes
 * whose branch was not selected, and keeps fan-in independent of completion
 * order. Loops compile to nested Mastra workflows so their bodies retain the
 * same parallelism recursively. Translation fails closed on cyclic or otherwise
 * unrepresentable topology and on unsupported kinds.
 */
import { z } from "zod";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import type { GraphEdgeInstance } from "../shared/graph/document/GraphEdgeInstance";
import type { Condition, SwitchNodeMetadata } from "../shared/graph";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
import type { GraphExecutionPlan } from "../engine/planning/GraphExecutionPlan";
import { GraphDependencyTopology } from "../engine/planning/GraphDependencyTopology";
import { graphRunDocumentFingerprint } from "../engine/runs/GraphRunFingerprint";
import { mastraScheduleConfigsOf } from "./MastraScheduleTrigger";
import {
  assertMastraResumeSchemaSafe,
  toMastraZodSchema,
} from "./MastraSchemaConverter";
import {
  assertMastraConditionSupported,
  mastraConditionPredicate,
} from "./MastraConditionBridge";
import {
  GRAPH_MASTRA_ROUTED_ENVELOPE,
  GRAPH_MASTRA_SKIPPED_NODE,
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  GRAPH_MASTRA_UNSUPPORTED_TOPOLOGY,
  type MastraBackendConfig,
  type MastraNodeStepHandler,
} from "./types";
import { withMastraRunConcurrency } from "./MastraRunConcurrencyLimiter";

/** Document kind translated into an `if` branch. */
export const GRAPH_MASTRA_IF_KIND = "core.flow.if";
/** Document kind translated into a `switch` branch set. */
export const GRAPH_MASTRA_SWITCH_KIND = "core.flow.switch";
/** Document kind translated into a `foreach` loop. */
export const GRAPH_MASTRA_FOREACH_KIND = "core.loop.foreach";
/** Document kind translated into a `do-while` loop. */
export const GRAPH_MASTRA_WHILE_KIND = "core.loop.while";
/** Document kind translated into a `do-until` loop. */
export const GRAPH_MASTRA_UNTIL_KIND = "core.loop.until";
/** Document kind translated into a Mastra approval step. */
export const GRAPH_MASTRA_HUMAN_APPROVAL_KIND = "core.flow.humanApproval";

interface MastraWorkflowBuilderLike {
  then(step: unknown): MastraWorkflowBuilderLike;
  parallel(steps: unknown): MastraWorkflowBuilderLike;
  map(mapping: unknown, options?: unknown): MastraWorkflowBuilderLike;
  commit(): unknown;
}

interface MastraStepLike {
  id?: string;
  execute?: (args: Record<string, unknown>) => unknown;
  [key: string]: unknown;
}

interface MastraRoutingArgs {
  inputData?: unknown;
  runId?: string;
  getInitData?: () => unknown;
  getStepResult?: (step: string) => unknown;
}

interface MastraRoutedNode {
  inputs: Record<string, unknown>;
  skipped: boolean;
}

/**
 * A compiled Mastra workflow plus everything resume and capability reporting
 * need: the translated steps by node id, the validated resume schemas by
 * suspendable node id, the dependency layers, and the node ids whose output
 * schemas degraded.
 *
 * @summary The cached translation result for one document revision.
 * @description The result is cached per document fingerprint, so calling
 * {@link MastraWorkflowCompiler.compile} again with the same document returns
 * this exact object. `layers` mirrors the dependency layers the workflow was
 * built from: one layer per native parallel group or sequential barrier.
 */
export interface MastraCompiledWorkflow {
  /** The canonical workflow id the workflow was compiled from. */
  workflowId: string;
  /** The document fingerprint the workflow was compiled from. */
  fingerprint: string;
  /** The cache key (`workflowId::fingerprint`) the compilation is stored under. */
  cacheKey: string;
  /** The committed Mastra workflow object. */
  workflow: unknown;
  /** The translated Mastra steps, keyed by document node id. */
  steps: Map<string, unknown>;
  /**
   * Dependency layers in execution order; each layer is emitted as a native
   * parallel group (several nodes) or a sequential barrier (one node).
   */
  layers: string[][];
  /** Validated resume schemas, keyed by suspendable node id. */
  resumeSchemas: Map<string, z.ZodTypeAny>;
  /** Node ids whose declared output schema degraded during conversion. */
  degradedSchemas: string[];
}

/**
 * Options a {@link MastraWorkflowCompiler} is created with.
 *
 * @description Step handlers are keyed by the document node kind they
 * translate. Handlers supplied later for the same kind replace earlier ones.
 */
export interface MastraWorkflowCompilerOptions {
  /** Node-kind step handlers used to translate leaf nodes. */
  stepHandlers?: MastraNodeStepHandler[];
  /** Optional backend configuration (reserved for handler plumbing). */
  config?: MastraBackendConfig;
}

/**
 * Options supplied per compilation.
 *
 * @summary Per-run inputs that refine how a document is compiled.
 */
export interface MastraCompilerRunOptions {
  /**
   * The planner-produced execution plan for the document.
   *
   * When supplied, its layers are authoritative: the compiler uses them
   * verbatim and rejects a plan that does not cover exactly the document's
   * node ids with `GRAPH_MASTRA_UNSUPPORTED_TOPOLOGY`. When omitted, the
   * compiler derives the same layers from the document's data/connection edges
   * through {@link GraphDependencyTopology}.
   */
  plan?: GraphExecutionPlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function nodeEndpointId(
  edge: GraphEdgeInstance,
  side: "source" | "target"
): string | undefined {
  const endpoint = edge[side];
  return endpoint.scope === "node" ? endpoint.nodeId : undefined;
}

function endpointPort(
  edge: GraphEdgeInstance,
  side: "source" | "target"
): string {
  return edge[side].port;
}

function dependencyEdgesOf(document: GraphWorkflowDocument): Array<{
  type: "data" | "connection";
  sourceNodeId: string;
  targetNodeId: string;
}> {
  return (document.edges ?? []).flatMap((edge) => {
    const sourceNodeId = nodeEndpointId(edge, "source");
    const targetNodeId = nodeEndpointId(edge, "target");
    return sourceNodeId && targetNodeId
      ? [
          {
            type: edge.type,
            sourceNodeId,
            targetNodeId,
          },
        ]
      : [];
  });
}

interface MastraBranchGating {
  /** Nodes reachable from a branch control along data edges. */
  sensitive: Set<string>;
  /** Branch control node ids (`core.flow.if` / `core.flow.switch`). */
  controls: Set<string>;
}

function branchGatingOf(document: GraphWorkflowDocument): MastraBranchGating {
  const nodeById = new Map((document.nodes ?? []).map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of document.edges ?? []) {
    if (edge.type !== "data") continue;
    const source = nodeEndpointId(edge, "source");
    const target = nodeEndpointId(edge, "target");
    if (!source || !target) continue;
    const list = outgoing.get(source) ?? [];
    list.push(target);
    outgoing.set(source, list);
  }
  const sensitive = new Set<string>();
  const controls = new Set<string>();
  const queue: string[] = [];
  for (const node of document.nodes ?? []) {
    if (
      node.kind === GRAPH_MASTRA_IF_KIND ||
      node.kind === GRAPH_MASTRA_SWITCH_KIND
    ) {
      controls.add(node.id);
      queue.push(node.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const target of outgoing.get(id) ?? []) {
      if (sensitive.has(target) || !nodeById.has(target)) continue;
      sensitive.add(target);
      queue.push(target);
    }
  }
  return { sensitive, controls };
}

function skippedStepOutput(): Record<string, unknown> {
  return { [GRAPH_MASTRA_SKIPPED_NODE]: true, reason: "branchNotSelected" };
}

/**
 * Translates canonical documents into cached Mastra workflows.
 *
 * @summary Builds a Mastra workflow from graph dependency layers, native
 * parallel groups, per-layer routing, and recursive loop compilation.
 * @description Leaf step translation is delegated to host-provided handlers;
 * control nodes (if/switch/loops/human approval) are translated by the compiler
 * itself. Each dependency layer is prefixed with a router that resolves node
 * inputs by graph port identity, then emitted as a `.then(...)` barrier for one
 * node or a native `workflow.parallel(...)` group for several. A node whose
 * branch was not selected receives the skip sentinel
 * ({@link GRAPH_MASTRA_SKIPPED_NODE}) instead of executing. Fan-in does not
 * depend on completion order because every layer reads the previous layers'
 * step results through the routing envelope. Loop bodies are compiled
 * recursively with the same parallelism. Translation fails closed on cyclic or
 * otherwise unrepresentable topology and on missing node kinds.
 */
export class MastraWorkflowCompiler {
  private readonly cache = new Map<string, MastraCompiledWorkflow>();
  private readonly handlers = new Map<string, MastraNodeStepHandler>();

  /**
   * Creates a compiler and indexes the supplied node-kind handlers.
   *
   * @param {MastraWorkflowCompilerOptions} [options] - Step handlers, optionally
   * with backend configuration reserved for handler plumbing. Defaults to no
   * handlers.
   */
  constructor(options: MastraWorkflowCompilerOptions = {}) {
    for (const handler of options.stepHandlers ?? []) {
      this.handlers.set(handler.kind, handler);
    }
  }

  /**
   * Clears the compiled-workflow cache.
   *
   * @summary Drops every cached translation so the next compile rebuilds.
   * @returns {void}
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Whether a compiled workflow is cached under a cache key.
   *
   * @param {string} cacheKey - The `workflowId::fingerprint` key.
   * @returns {boolean} `true` when a translation is cached for the key.
   */
  has(cacheKey: string): boolean {
    return this.cache.has(cacheKey);
  }

  /**
   * Returns the cached translation for a document revision.
   *
   * @param {GraphWorkflowDocument} document - The canonical document to look up.
   * @returns {MastraCompiledWorkflow | undefined} The cached translation for the
   * document's current fingerprint, or `undefined` when it has not been compiled.
   */
  get(document: GraphWorkflowDocument): MastraCompiledWorkflow | undefined {
    return this.cache.get(this.cacheKeyOf(document));
  }

  /**
   * Builds the cache key for a document revision.
   *
   * @param {GraphWorkflowDocument} document - The canonical document.
   * @returns {string} The `workflowId::fingerprint` cache key. Any content
   * change produces a new fingerprint and therefore a new cache entry.
   */
  cacheKeyOf(document: GraphWorkflowDocument): string {
    return `${document.id}::${graphRunDocumentFingerprint(document)}`;
  }

  /**
   * Compiles a document into a Mastra workflow.
   *
   * @summary Translates one document revision, reusing the cached translation
   * for that revision when one already exists.
   * @description The cache key is the document id plus its fingerprint; options
   * do not participate, so only the first compile of a revision runs and later
   * calls for the same revision return that translation regardless of options.
   * When the compile runs and the caller supplies the planner's execution plan,
   * its validated layers are authoritative and must cover exactly the document's
   * node ids; otherwise the compiler derives the same layers from the shared
   * dependency topology. Each layer is preceded by a routing map and emitted as
   * a native parallel group (more than one node) or a sequential barrier (one
   * node). Nodes not selected by a branch receive a skip sentinel that the event
   * bridge maps to `NODE_SKIPPED`. Loop bodies are compiled recursively as
   * nested Mastra workflows.
   * @param {GraphWorkflowDocument} document - The canonical workflow document to
   * translate.
   * @param {MastraCompilerRunOptions} [options] - Per-run options; pass the
   * execution plan to make its layers authoritative.
   * @returns {MastraCompiledWorkflow} The committed workflow, translated steps,
   * dependency layers, resume schemas, and degraded-schema node ids.
   * @throws {GraphExecutionError} with `GRAPH_MASTRA_UNSUPPORTED_TOPOLOGY` when a
   * supplied plan does not cover the document, the document is cyclic, a loop is
   * conditionally activated, or a loop has no body; with
   * `GRAPH_MASTRA_UNSUPPORTED_KIND` when a node kind has no registered handler.
   * @example
   * const compiler = new MastraWorkflowCompiler({ stepHandlers });
   * const compiled = compiler.compile(document, { plan });
   * // compiled.layers mirrors the planner's dependency layers.
   * @mermaid
   * sequenceDiagram
   *   autonumber
   *   participant C as MastraWorkflowCompiler
   *   participant P as Plan / Topology
   *   participant W as Mastra workflow
   *   C->>C: cacheKeyOf(document)
   *   alt cached
   *     C-->>C: return cached translation
   *   else not cached
   *     C->>P: layersOf(document, plan)
   *     activate P
   *     P-->>C: dependency layers
   *     deactivate P
   *     loop each layer
   *       C->>W: map(router)
   *       alt one node
   *         C->>W: then(step)
   *       else several nodes
   *         C->>W: parallel(steps)
   *       end
   *     end
   *     C->>W: commit()
   *     C-->>C: cache and return translation
   *   end
   */
  compile(
    document: GraphWorkflowDocument,
    options: MastraCompilerRunOptions = {}
  ): MastraCompiledWorkflow {
    const cacheKey = this.cacheKeyOf(document);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const steps = new Map<string, unknown>();
    const resumeSchemas = new Map<string, z.ZodTypeAny>();
    const degradedSchemas: string[] = [];
    const layers = this.layersOf(document, options.plan);
    const schedule = mastraScheduleConfigsOf(document);
    const builder = createWorkflow({
      id: document.id,
      inputSchema: z.any(),
      outputSchema: z.any(),
      ...(schedule ? { schedule } : {}),
    }) as unknown as MastraWorkflowBuilderLike;

    const nodeById = new Map(
      (document.nodes ?? []).map((node) => [node.id, node])
    );
    const branchGating = branchGatingOf(document);
    let cursor: MastraWorkflowBuilderLike = builder;
    for (const layer of layers) {
      cursor = cursor.map(
        this.buildLayerRouter(document, layer, branchGating)
      );
      const layerSteps = layer.map((nodeId) => {
        const node = nodeById.get(nodeId);
        if (!node) {
          throw new GraphExecutionError(
            `Mastra compilation plan references unknown node '${nodeId}'`,
            GRAPH_MASTRA_UNSUPPORTED_TOPOLOGY,
            { workflowId: document.id, nodeId }
          );
        }
        return this.buildNodeStep(
          node,
          document,
          steps,
          resumeSchemas,
          degradedSchemas
        );
      });
      cursor =
        layerSteps.length === 1
          ? cursor.then(layerSteps[0])
          : cursor.parallel(layerSteps);
    }

    const outputMapping = this.buildWorkflowOutputMapping(document);
    if (outputMapping) cursor = cursor.map(outputMapping);
    const workflow = cursor.commit();

    const compiled: MastraCompiledWorkflow = {
      workflowId: document.id,
      fingerprint: graphRunDocumentFingerprint(document),
      cacheKey,
      workflow,
      steps,
      layers,
      resumeSchemas,
      degradedSchemas,
    };
    this.cache.set(cacheKey, compiled);
    return compiled;
  }

  private layersOf(
    document: GraphWorkflowDocument,
    plan?: GraphExecutionPlan
  ): string[][] {
    const nodeIds = (document.nodes ?? []).map((node) => node.id);
    const known = new Set(nodeIds);
    if (plan) {
      const planned = plan.layers.map((layer) =>
        layer.nodes.map((node) => node.id)
      );
      const flattened = planned.flat();
      const matches =
        flattened.length === nodeIds.length &&
        flattened.every((id) => known.has(id)) &&
        nodeIds.every((id) => flattened.includes(id));
      if (!matches) {
        throw new GraphExecutionError(
          `Mastra compilation plan does not cover workflow '${document.id}'`,
          GRAPH_MASTRA_UNSUPPORTED_TOPOLOGY,
          {
            workflowId: document.id,
            plannedNodes: flattened,
            documentNodes: nodeIds,
          }
        );
      }
      return planned;
    }
    try {
      return GraphDependencyTopology.layers(
        document.nodes ?? [],
        dependencyEdgesOf(document),
        document.id
      );
    } catch (error) {
      throw new GraphExecutionError(
        `Mastra translation requires an acyclic workflow document (${document.id})`,
        GRAPH_MASTRA_UNSUPPORTED_TOPOLOGY,
        {
          workflowId: document.id,
          cause:
            error instanceof Error ? error.message : "unsupported topology",
        }
      );
    }
  }

  private buildNodeStep(
    node: GraphNodeInstance,
    document: GraphWorkflowDocument,
    steps: Map<string, unknown>,
    resumeSchemas: Map<string, z.ZodTypeAny>,
    degradedSchemas: string[]
  ): unknown {
    let step: unknown;
    if (node.kind === GRAPH_MASTRA_IF_KIND) {
      step = this.buildIfStep(node);
    } else if (node.kind === GRAPH_MASTRA_SWITCH_KIND) {
      step = this.buildSwitchStep(node);
    } else if (
      node.kind === GRAPH_MASTRA_FOREACH_KIND ||
      node.kind === GRAPH_MASTRA_WHILE_KIND ||
      node.kind === GRAPH_MASTRA_UNTIL_KIND
    ) {
      step = this.buildLoopWorkflow(node, document);
    } else if (node.kind === GRAPH_MASTRA_HUMAN_APPROVAL_KIND) {
      step = this.buildHumanApprovalStep(node, resumeSchemas);
    } else {
      step = this.buildLeafStep(node, degradedSchemas, document);
    }
    const wrapped =
      node.kind === GRAPH_MASTRA_FOREACH_KIND ||
      node.kind === GRAPH_MASTRA_WHILE_KIND ||
      node.kind === GRAPH_MASTRA_UNTIL_KIND
        ? step
        : this.wrapStep(step, node);
    steps.set(node.id, wrapped);
    return wrapped;
  }

  private wrapStep(step: unknown, node: GraphNodeInstance): unknown {
    const candidate = step as MastraStepLike;
    if (typeof candidate?.execute !== "function") return step;
    const execute = candidate.execute.bind(step);
    return {
      ...candidate,
      id: node.id,
      metadata: {
        ...(isRecord(candidate.metadata) ? candidate.metadata : {}),
        decafNode: { id: node.id, kind: node.kind },
      },
      execute: async (args: MastraRoutingArgs) => {
        const envelope = asRecord(args?.inputData)[GRAPH_MASTRA_ROUTED_ENVELOPE];
        const routed = asRecord(envelope)[node.id] as
          | MastraRoutedNode
          | undefined;
        if (routed?.skipped) return skippedStepOutput();
        const inputData =
          routed && isRecord(routed.inputs)
            ? routed.inputs
            : asRecord(args?.inputData);
        return await withMastraRunConcurrency(args?.runId, () =>
          execute({ ...args, inputData })
        );
      },
    };
  }

  private buildLayerRouter(
    document: GraphWorkflowDocument,
    layer: string[],
    branchGating: MastraBranchGating
  ): (args: MastraRoutingArgs) => Promise<Record<string, unknown>> {
    return async (args: MastraRoutingArgs) => {
      const initData = asRecord(args?.getInitData?.());
      const routed: Record<string, MastraRoutedNode> = {};
      for (const nodeId of layer) {
        routed[nodeId] = this.routeNodeInputs(
          document,
          nodeId,
          initData,
          args?.getStepResult,
          branchGating
        );
      }
      return { [GRAPH_MASTRA_ROUTED_ENVELOPE]: routed };
    };
  }

  private routeNodeInputs(
    document: GraphWorkflowDocument,
    nodeId: string,
    initData: Record<string, unknown>,
    getStepResult: ((step: string) => unknown) | undefined,
    branchGating: MastraBranchGating
  ): MastraRoutedNode {
    const incoming = (document.edges ?? []).filter(
      (edge) =>
        edge.type === "data" && nodeEndpointId(edge, "target") === nodeId
    );
    const node = (document.nodes ?? []).find((entry) => entry.id === nodeId);

    const valueOf = (edge: GraphEdgeInstance): unknown => {
      const sourcePort = endpointPort(edge, "source");
      if (edge.source.scope === "workflow") {
        return initData[sourcePort];
      }
      const sourceId = nodeEndpointId(edge, "source");
      if (!sourceId) return undefined;
      let output: unknown;
      try {
        output = getStepResult?.(sourceId);
      } catch {
        output = undefined;
      }
      return isRecord(output) && Object.prototype.hasOwnProperty.call(output, sourcePort)
        ? output[sourcePort]
        : undefined;
    };

    const emitted = (edge: GraphEdgeInstance): boolean => {
      if (edge.source.scope === "workflow") return true;
      const sourceId = nodeEndpointId(edge, "source");
      if (!sourceId) return false;
      let output: unknown;
      try {
        output = getStepResult?.(sourceId);
      } catch {
        return false;
      }
      return (
        isRecord(output) &&
        Object.prototype.hasOwnProperty.call(
          output,
          endpointPort(edge, "source")
        )
      );
    };

    const gatedByBranch = branchGating.sensitive.has(nodeId);
    const branchEdges = gatedByBranch
      ? incoming.filter((edge) => {
          if (edge.source.scope === "workflow") return false;
          const sourceId = nodeEndpointId(edge, "source");
          return (
            sourceId !== undefined &&
            (branchGating.sensitive.has(sourceId) ||
              branchGating.controls.has(sourceId))
          );
        })
      : [];

    const active =
      !gatedByBranch ||
      branchEdges.length === 0 ||
      branchEdges.some((edge) => emitted(edge));
    if (!active) {
      return { inputs: {}, skipped: true };
    }

    const inputs: Record<string, unknown> = incoming.length === 0
      ? { ...initData }
      : {};
    if (incoming.length > 0) {
      const byTargetPort = new Map<string, GraphEdgeInstance[]>();
      for (const edge of incoming) {
        const list = byTargetPort.get(edge.target.port) ?? [];
        list.push(edge);
        byTargetPort.set(edge.target.port, list);
      }
      for (const [targetPort, edges] of byTargetPort) {
        if (edges.length === 1) {
          inputs[targetPort] = valueOf(edges[0]);
          continue;
        }
        let definedValue: unknown;
        let hasDefined = false;
        for (const edge of edges) {
          const value = valueOf(edge);
          inputs[endpointPort(edge, "source")] = value;
          if (value !== undefined) {
            definedValue = value;
            hasDefined = true;
          }
        }
        if (hasDefined && inputs[targetPort] === undefined) {
          inputs[targetPort] = definedValue;
        }
      }
    }

    for (const [port, binding] of Object.entries(node?.inputBindings ?? {})) {
      if (isRecord(binding) && binding.mode === "literal") {
        inputs[port] = binding.value;
      }
    }
    return { inputs, skipped: false };
  }

  private buildWorkflowOutputMapping(
    document: GraphWorkflowDocument
  ):
    | ((args: MastraRoutingArgs) => Promise<Record<string, unknown>>)
    | undefined {
    const outputEdges = (document.edges ?? []).filter(
      (edge) => edge.type === "data" && edge.target.scope === "workflow"
    );
    if (outputEdges.length === 0) return undefined;
    return async (args: MastraRoutingArgs) => {
      const initData = asRecord(args?.getInitData?.());
      const outputs: Record<string, unknown> = {};
      for (const edge of outputEdges) {
        const sourcePort = endpointPort(edge, "source");
        const targetPort = endpointPort(edge, "target");
        let value: unknown;
        if (edge.source.scope === "workflow") {
          value = initData[sourcePort];
        } else {
          const sourceId = nodeEndpointId(edge, "source");
          let output: unknown;
          try {
            output = sourceId ? args?.getStepResult?.(sourceId) : undefined;
          } catch {
            output = undefined;
          }
          if (
            !isRecord(output) ||
            !Object.prototype.hasOwnProperty.call(output, sourcePort)
          ) {
            continue;
          }
          value = output[sourcePort];
        }
        if (value !== undefined || outputs[targetPort] === undefined) {
          outputs[targetPort] = value;
        }
      }
      return outputs;
    };
  }

  private buildIfStep(node: GraphNodeInstance): unknown {
    const parameters = node.parameters ?? {};
    const metadata = node.metadata ?? {};
    const condition = (parameters["condition"] ?? metadata["condition"]) as
      | Condition
      | undefined;
    assertMastraConditionSupported(condition, node.id);
    const predicate = mastraConditionPredicate(condition!, "if");
    const elseEnabled = parameters["else"] === true;
    return createStep({
      id: node.id,
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async (args: { inputData?: unknown }) => {
        const input = asRecord(args?.inputData);
        const value = input["value"] ?? input;
        if (predicate({ inputData: input })) return { then: value };
        if (elseEnabled) return { else: value };
        throw new GraphExecutionError(
          `If node '${node.id}' condition evaluated to false and the else branch is disabled`,
          "GRAPH_IF_ELSE_DISABLED",
          { nodeId: node.id }
        );
      },
    });
  }

  private buildSwitchStep(node: GraphNodeInstance): unknown {
    const metadata = this.switchMetadataOf(node);
    for (const switchCase of metadata.cases) {
      assertMastraConditionSupported(switchCase.condition, node.id);
    }
    return createStep({
      id: node.id,
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async (args: { inputData?: unknown }) => {
        const input = asRecord(args?.inputData);
        const value = input["value"] ?? input;
        for (const switchCase of metadata.cases) {
          const predicate = mastraConditionPredicate(
            switchCase.condition,
            "switch case"
          );
          if (predicate({ inputData: input })) {
            return { [switchCase.outputPort]: value };
          }
        }
        if (metadata.hasDefault === true && metadata.defaultPort) {
          return { [metadata.defaultPort]: value };
        }
        throw new GraphExecutionError(
          `No switch case matched for node '${node.id}' and default port is not enabled`,
          "GRAPH_SWITCH_NO_MATCH",
          { nodeId: node.id, cases: metadata.cases.map((entry) => entry.id) }
        );
      },
    });
  }

  private buildHumanApprovalStep(
    node: GraphNodeInstance,
    resumeSchemas: Map<string, z.ZodTypeAny>
  ): unknown {
    const parameters = node.parameters ?? {};
    const declaredResumeSchema = parameters["resumeSchema"];
    if (declaredResumeSchema === undefined) {
      return createStep({
        id: node.id,
        inputSchema: z.any(),
        outputSchema: z.any(),
        execute: async (args: { inputData?: unknown }) => {
          const inputData = asRecord(args?.inputData);
          const value = inputData["value"] ?? inputData;
          return parameters["approved"] === false
            ? { rejected: value }
            : { approved: value };
        },
      });
    }
    const suspendSchema = toMastraZodSchema(
      parameters["suspendSchema"] as never
    );
    const resumeSchema = assertMastraResumeSchemaSafe(
      declaredResumeSchema as never
    );
    resumeSchemas.set(node.id, resumeSchema);
    return createStep({
      id: node.id,
      inputSchema: z.any(),
      outputSchema: z.any(),
      suspendSchema: suspendSchema.schema,
      resumeSchema,
      execute: async (args: {
        inputData?: unknown;
        suspend?: (payload?: unknown) => unknown;
        resumeData?: unknown;
      }) => {
        if (args.resumeData === undefined) {
          await args.suspend?.({
            message: parameters["message"],
            approvers: parameters["approvers"],
          });
        }
        const resumeData = args.resumeData as
          | { approved?: unknown; value?: unknown }
          | undefined;
        const value = resumeData?.value ?? resumeData;
        return resumeData?.approved === false
          ? { rejected: value }
          : { approved: value };
      },
    });
  }

  private buildLoopWorkflow(
    node: GraphNodeInstance,
    document: GraphWorkflowDocument
  ): unknown {
    if (!node.loop || !node.loop.body) {
      throw new GraphExecutionError(
        `Mastra loop node '${node.id}' has no loop body to translate`,
        GRAPH_MASTRA_UNSUPPORTED_KIND,
        { nodeId: node.id }
      );
    }
    if (branchGatingOf(document).sensitive.has(node.id)) {
      throw new GraphExecutionError(
        `Mastra loop node '${node.id}' is conditionally activated by a branch, which cannot be represented faithfully`,
        GRAPH_MASTRA_UNSUPPORTED_TOPOLOGY,
        { nodeId: node.id, workflowId: document.id }
      );
    }
    const parameters = node.parameters ?? {};
    const body = new MastraWorkflowCompiler({
      stepHandlers: [...this.handlers.values()],
    }).compile(node.loop.body);

    if (node.kind === GRAPH_MASTRA_FOREACH_KIND) {
      const itemPort =
        (parameters["itemPort"] as string | undefined) ?? "item";
      const resultPort =
        (parameters["resultPort"] as string | undefined) ?? "result";
      const concurrency =
        typeof node.loop.concurrency === "number"
          ? node.loop.concurrency
          : undefined;
      const bodyInput = this.buildLoopBodyInput(
        node.id,
        body.workflow,
        (inputData) => ({ [itemPort]: inputData })
      );
      const loopWorkflow = createWorkflow({
        id: node.id,
        inputSchema: z.any(),
        outputSchema: z.any(),
      })
        .map(
          this.buildLoopInputMapping(node.id, (inputs) => inputs["items"])
        )
        .foreach(
          bodyInput as never,
          concurrency !== undefined ? { concurrency } : undefined
        )
        .map(async (args: { inputData?: unknown }) => {
          const results = Array.isArray(args?.inputData)
            ? args.inputData
            : [];
          const completed = results.map((entry) =>
            isRecord(entry) &&
            Object.prototype.hasOwnProperty.call(entry, resultPort)
              ? entry[resultPort]
              : entry
          );
          return {
            completed,
            results,
            iterations: results.length,
            broken: false,
          };
        })
        .commit();
      return loopWorkflow;
    }

    const statePort =
      (parameters["statePort"] as string | undefined) ?? "state";
    const inputPort =
      (parameters["inputPort"] as string | undefined) ?? statePort;
    const outputPort =
      (parameters["outputPort"] as string | undefined) ?? statePort;
    const condition = (parameters["condition"] ?? node.metadata?.["condition"]) as
      | Condition
      | undefined;
    assertMastraConditionSupported(condition, node.id);
    const predicate = mastraConditionPredicate(condition!, "loop");
    const asyncPredicate = async (args: {
      inputData?: unknown;
      state?: unknown;
    }): Promise<boolean> => predicate(args);
    const bodyInput = this.buildLoopBodyInput(
      node.id,
      body.workflow,
      (inputData) => ({ [inputPort]: inputData })
    );
    const rawBody = createWorkflow({
      id: `${node.id}::body`,
      inputSchema: z.any(),
      outputSchema: z.any(),
    })
      .then(bodyInput as never)
      .map(async (args: { inputData?: unknown }) => {
        const output = asRecord(args?.inputData);
        return Object.prototype.hasOwnProperty.call(output, outputPort)
          ? output[outputPort]
          : output;
      })
      .commit();
    const mapped = createWorkflow({
      id: node.id,
      inputSchema: z.any(),
      outputSchema: z.any(),
    }).map(
      this.buildLoopInputMapping(node.id, (inputs) => inputs[statePort])
    );
    const looped =
      node.kind === GRAPH_MASTRA_WHILE_KIND
        ? mapped.dowhile(rawBody as never, asyncPredicate)
        : mapped.dountil(rawBody as never, asyncPredicate);
    return looped
      .map(async (args: { inputData?: unknown }) => ({
        [outputPort]: args?.inputData,
        state: args?.inputData,
      }))
      .commit();
  }

  private buildLoopBodyInput(
    nodeId: string,
    bodyWorkflow: unknown,
    shape: (inputData: unknown) => Record<string, unknown>
  ): unknown {
    return createWorkflow({
      id: `${nodeId}::body-input`,
      inputSchema: z.any(),
      outputSchema: z.any(),
    })
      .map(async (args: { inputData?: unknown }) => shape(args?.inputData))
      .then(bodyWorkflow as never)
      .commit();
  }

  private buildLoopInputMapping(
    nodeId: string,
    select: (inputs: Record<string, unknown>) => unknown
  ): (args: MastraRoutingArgs) => Promise<unknown> {
    return async (args: MastraRoutingArgs) => {
      const envelope = asRecord(args?.inputData)[GRAPH_MASTRA_ROUTED_ENVELOPE];
      const routed = asRecord(envelope)[nodeId] as MastraRoutedNode | undefined;
      if (routed?.skipped) return [];
      const inputs =
        routed && isRecord(routed.inputs)
          ? routed.inputs
          : asRecord(args?.inputData);
      return select(inputs);
    };
  }

  private buildLeafStep(
    node: GraphNodeInstance,
    degradedSchemas: string[],
    document?: GraphWorkflowDocument
  ): unknown {
    const handler = this.handlers.get(node.kind);
    if (!handler) {
      throw new GraphExecutionError(
        `Mastra backend has no step handler for node kind '${node.kind}'`,
        GRAPH_MASTRA_UNSUPPORTED_KIND,
        { nodeId: node.id, kind: node.kind }
      );
    }
    const step = handler.createStep(node, {
      stepId: node.id,
      document,
    });
    const schema = toMastraZodSchema(node.metadata?.["outputSchema"] as never);
    if (schema.degraded) degradedSchemas.push(node.id);
    return step;
  }

  private switchMetadataOf(node: GraphNodeInstance): SwitchNodeMetadata {
    const metadata = node.metadata?.["switch"];
    if (isRecord(metadata) && Array.isArray(metadata["cases"])) {
      return metadata as unknown as SwitchNodeMetadata;
    }
    const parameters = node.parameters ?? {};
    return {
      cases:
        (parameters["cases"] as unknown as SwitchNodeMetadata["cases"]) ?? [],
      defaultPort:
        (parameters["defaultPort"] as string | undefined) ?? "default",
      hasDefault: parameters["hasDefault"] === true,
    };
  }
}

