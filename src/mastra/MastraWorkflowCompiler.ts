/**
 * @module as-graph/mastra/MastraWorkflowCompiler
 * @summary Compiles canonical workflow documents into Mastra workflows
 * (SAA-196).
 * @description The compiler translates the canonical document's topological
 * order into Mastra builder calls: leaf nodes become steps via host-provided
 * handlers, `if`/`switch` nodes become branches over shared condition
 * predicates, loops nest a recursive sub-compilation, and human-approval nodes
 * become suspending steps with validated resume schemas. Compiled workflows are
 * cached by document id and fingerprint; translation fails closed on unsupported
 * kinds and cyclic documents.
 */
import { z } from "zod";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { GraphWorkflowDocument } from "../shared/graph/document/GraphWorkflowDocument";
import type { GraphNodeInstance } from "../shared/graph/document/GraphNodeInstance";
import type { GraphEdgeInstance } from "../shared/graph/document/GraphEdgeInstance";
import type { Condition, SwitchNodeMetadata } from "../shared/graph";
import { GraphExecutionError } from "../engine/errors/GraphExecutionError";
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
  GRAPH_MASTRA_UNSUPPORTED_KIND,
  type MastraBackendConfig,
  type MastraNodeStepHandler,
} from "./types";

/** Document kind translated into a Mastra `if` branch. */
export const GRAPH_MASTRA_IF_KIND = "core.flow.if";
/** Document kind translated into a Mastra `switch` branch set. */
export const GRAPH_MASTRA_SWITCH_KIND = "core.flow.switch";
/** Document kind translated into a Mastra `foreach` loop. */
export const GRAPH_MASTRA_FOREACH_KIND = "core.loop.foreach";
/** Document kind translated into a Mastra `do-while` loop. */
export const GRAPH_MASTRA_WHILE_KIND = "core.loop.while";
/** Document kind translated into a Mastra `do-until` loop. */
export const GRAPH_MASTRA_UNTIL_KIND = "core.loop.until";
/** Document kind translated into a Mastra suspending approval step. */
export const GRAPH_MASTRA_HUMAN_APPROVAL_KIND = "core.flow.humanApproval";

/**
 * Stamps the OUR-node observability origin (SAA-836 O1) onto a translated
 * Mastra step: the step's entry `metadata` carries the canonical node id and
 * kind under the `decafNode` key, which mastra attaches to the step's
 * `WORKFLOW_STEP` span attributes as `entryMetadata`. The mastra engine's
 * observability pipeline therefore exports every OUR-node span with its
 * canonical origin, and {@link DecafNodeObservabilityExporter} can isolate
 * OUR-node signals in OUR observability layer while mastra catches everything
 * on its engine.
 *
 * @param step - The translated step to stamp.
 * @param node - The canonical node the step was translated from.
 * @returns The same step, with the origin stamped into its metadata.
 */
function stampDecafNodeOrigin(step: unknown, node: GraphNodeInstance): unknown {
  const candidate = step as { metadata?: Record<string, unknown> } | null;
  if (!candidate || typeof candidate !== "object") return step;
  candidate.metadata = {
    ...(candidate.metadata ?? {}),
    decafNode: { id: node.id, kind: node.kind },
  };
  return step;
}

/**
 * Structural subset of the Mastra workflow builder the compiler drives. Kept
 * loose (`unknown` step/condition payloads) so the compiler compiles against
 * any `@mastra/core` minor without type coupling.
 */interface MastraWorkflowBuilderLike {
  then(step: unknown): MastraWorkflowBuilderLike;
  branch(branches: unknown): MastraWorkflowBuilderLike;
  foreach(step: unknown, options?: unknown): MastraWorkflowBuilderLike;
  dowhile(step: unknown, condition: unknown): MastraWorkflowBuilderLike;
  dountil(step: unknown, condition: unknown): MastraWorkflowBuilderLike;
  parallel(steps: unknown): MastraWorkflowBuilderLike;
  map(mapping: unknown): MastraWorkflowBuilderLike;
  commit(): unknown;
}

/**
 * A compiled Mastra workflow plus everything resume and capability reporting
 * need: the translated steps by node id, the validated resume schemas by
 * suspendable node id, and the node ids whose output schemas degraded.
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
  /** Validated resume schemas, keyed by suspendable node id. */
  resumeSchemas: Map<string, z.ZodTypeAny>;
  /** Node ids whose declared output schema degraded during conversion. */
  degradedSchemas: string[];
}

/** Options a {@link MastraWorkflowCompiler} is created with. */
export interface MastraWorkflowCompilerOptions {
  /** Node-kind step handlers used to translate leaf nodes. */
  stepHandlers?: MastraNodeStepHandler[];
  /** Optional backend configuration (reserved for handler plumbing). */
  config?: MastraBackendConfig;
}

/**
 * Structural check for a plain (non-array) object value.
 *
 * @param value - The value to test.
 * @returns `true` when the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolves the node-scoped endpoint id of an edge side.
 *
 * @param edge - The edge to inspect.
 * @param side - Which side of the edge to read.
 * @returns The node id when the endpoint is node-scoped, else `undefined`.
 */
function nodeEndpointId(
  edge: GraphEdgeInstance,
  side: "source" | "target"
): string | undefined {
  const endpoint = edge[side];
  return endpoint.scope === "node" ? endpoint.nodeId : undefined;
}

/**
 * Orders a document's nodes topologically over its node-scoped data edges.
 *
 * @param document - The document to order.
 * @returns The nodes in dependency order.
 * @throws {GraphExecutionError} {@link GRAPH_MASTRA_UNSUPPORTED_KIND} when the
 *   document contains a data-edge cycle.
 */
function topologicalOrder(
  document: GraphWorkflowDocument
): GraphNodeInstance[] {
  const nodes = document.nodes ?? [];
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of document.edges ?? []) {
    if (edge.type !== "data") continue;
    const source = nodeEndpointId(edge, "source");
    const target = nodeEndpointId(edge, "target");
    if (!source || !target) continue;
    if (!indegree.has(target) || !outgoing.has(source)) continue;
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
    outgoing.get(source)!.push(target);
  }
  const queue = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const ordered: GraphNodeInstance[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (node) ordered.push(node);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (ordered.length !== nodes.length) {
    throw new GraphExecutionError(
      `Mastra translation requires an acyclic workflow document (${document.id})`,
      GRAPH_MASTRA_UNSUPPORTED_KIND,
      { workflowId: document.id }
    );
  }
  return ordered;
}

/**
 * Translates canonical documents into cached Mastra workflows. Leaf node
 * translation is delegated entirely to host-provided step handlers, so the
 * compiler has no node executors of its own and fails closed when a kind has no
 * handler.
 */
export class MastraWorkflowCompiler {
  /** Compiled workflows keyed by `workflowId::fingerprint`. */
  private readonly cache = new Map<string, MastraCompiledWorkflow>();
  /** Node-kind step handlers used for leaf translation. */
  private readonly handlers = new Map<string, MastraNodeStepHandler>();

  /**
   * Creates the compiler with an optional set of step handlers.
   *
   * @param options - Step handlers and optional backend configuration.
   */
  constructor(options: MastraWorkflowCompilerOptions = {}) {
    for (const handler of options.stepHandlers ?? []) {
      this.handlers.set(handler.kind, handler);
    }
  }

  /** Clears the compiled-workflow cache. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Whether a workflow is cached under the given cache key.
   *
   * @param cacheKey - The cache key to probe.
   * @returns `true` when a compilation is cached.
   */
  has(cacheKey: string): boolean {
    return this.cache.has(cacheKey);
  }

  /**
   * Returns the cached compilation for a document, if any.
   *
   * @param document - The document whose compilation to look up.
   * @returns The cached compilation, or `undefined` on a cache miss.
   */
  get(document: GraphWorkflowDocument): MastraCompiledWorkflow | undefined {
    return this.cache.get(this.cacheKeyOf(document));
  }

  /**
   * Computes the compilation cache key of a document.
   *
   * @param document - The document to key.
   * @returns The `workflowId::fingerprint` cache key.
   */
  cacheKeyOf(document: GraphWorkflowDocument): string {
    return `${document.id}::${graphRunDocumentFingerprint(document)}`;
  }

  /**
   * Compiles a document into a Mastra workflow, returning the cached
   * compilation on a cache hit. Steps are applied in the document's topological
   * order and the resulting builder is committed.
   *
   * @param document - The canonical document to compile.
   * @returns The compiled workflow, steps, and resume-schema bookkeeping.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_UNSUPPORTED_KIND} when the
   *   document is cyclic or a node kind has no step handler.
   */
  compile(document: GraphWorkflowDocument): MastraCompiledWorkflow {
    const cacheKey = this.cacheKeyOf(document);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const steps = new Map<string, unknown>();
    const resumeSchemas = new Map<string, z.ZodTypeAny>();
    const degradedSchemas: string[] = [];
    // SAA-836 M6: schedule trigger nodes declare mastra's native
    // scheduled-workflow functionality — the compiled workflow is created
    // with the declarative `schedule` input so the mastra scheduler starts
    // runs on each cron fire. A schedule trigger without a resolvable cron
    // fails closed (see `mastraScheduleConfigsOf`).
    const schedule = mastraScheduleConfigsOf(document);
    const builder = createWorkflow({
      id: document.id,
      inputSchema: z.any(),
      outputSchema: z.any(),
      ...(schedule ? { schedule } : {}),
    }) as unknown as MastraWorkflowBuilderLike;

    const ordered = topologicalOrder(document);
    let cursor: MastraWorkflowBuilderLike = builder;
    for (const node of ordered) {
      cursor = this.applyNode(
        cursor,
        node,
        document,
        steps,
        resumeSchemas,
        degradedSchemas
      );
    }
    const workflow = cursor.commit();

    const compiled: MastraCompiledWorkflow = {
      workflowId: document.id,
      fingerprint: graphRunDocumentFingerprint(document),
      cacheKey,
      workflow,
      steps,
      resumeSchemas,
      degradedSchemas,
    };
    this.cache.set(cacheKey, compiled);
    return compiled;
  }

  /**
   * Applies one node to the builder, dispatching on its kind: branch, switch,
   * loop, human approval, or leaf step.
   *
   * @param cursor - The builder position to extend.
   * @param node - The document node to translate.
   * @param document - The document being compiled.
   * @param steps - Accumulated steps by node id.
   * @param resumeSchemas - Accumulated resume schemas by node id.
   * @param degradedSchemas - Accumulated degraded-schema node ids.
   * @returns The extended builder position.
   */
  private applyNode(
    cursor: MastraWorkflowBuilderLike,
    node: GraphNodeInstance,
    document: GraphWorkflowDocument,
    steps: Map<string, unknown>,
    resumeSchemas: Map<string, z.ZodTypeAny>,
    degradedSchemas: string[]
  ): MastraWorkflowBuilderLike {
    if (node.kind === GRAPH_MASTRA_IF_KIND) {
      return this.applyIf(
        cursor,
        node,
        document,
        steps,
        resumeSchemas,
        degradedSchemas
      );
    }
    if (node.kind === GRAPH_MASTRA_SWITCH_KIND) {
      return this.applySwitch(
        cursor,
        node,
        document,
        steps,
        resumeSchemas,
        degradedSchemas
      );
    }
    if (
      node.kind === GRAPH_MASTRA_FOREACH_KIND ||
      node.kind === GRAPH_MASTRA_WHILE_KIND ||
      node.kind === GRAPH_MASTRA_UNTIL_KIND
    ) {
      return this.applyLoop(
        cursor,
        node,
        document,
        steps,
        resumeSchemas,
        degradedSchemas
      );
    }
    if (node.kind === GRAPH_MASTRA_HUMAN_APPROVAL_KIND) {
      return this.applyHumanApproval(
        cursor,
        node,
        steps,
        resumeSchemas,
        degradedSchemas
      );
    }
    const step = this.buildLeafStep(node, steps, degradedSchemas, document);
    return cursor.then(step);
  }

  /**
   * Translates an `if` node into a Mastra branch over its `then` and optional
   * `else` targets, guarded by the node's condition.
   *
   * @param cursor - The builder position to extend.
   * @param node - The `if` node to translate.
   * @param document - The document being compiled.
   * @param steps - Accumulated steps by node id.
   * @param resumeSchemas - Accumulated resume schemas by node id.
   * @param degradedSchemas - Accumulated degraded-schema node ids.
   * @returns The extended builder position.
   * @throws {GraphExecutionError} When the condition is missing or code-mode.
   */
  private applyIf(
    cursor: MastraWorkflowBuilderLike,
    node: GraphNodeInstance,
    document: GraphWorkflowDocument,
    steps: Map<string, unknown>,
    resumeSchemas: Map<string, z.ZodTypeAny>,
    degradedSchemas: string[]
  ): MastraWorkflowBuilderLike {
    const condition = this.conditionOf(node);
    assertMastraConditionSupported(condition, node.id);
    const thenStep = this.targetStep(
      node.id,
      "then",
      document,
      steps,
      resumeSchemas,
      degradedSchemas
    );
    const elseStep = this.targetStep(
      node.id,
      "else",
      document,
      steps,
      resumeSchemas,
      degradedSchemas
    );
    const branches: Array<[unknown, unknown]> = [
      [mastraConditionPredicate(condition!, "if"), thenStep],
    ];
    if (elseStep) {
      branches.push([() => true, elseStep]);
    }
    return cursor.branch(branches);
  }

  /**
   * Translates a `switch` node into a Mastra branch set over its declared
   * cases and optional default port; fails when no branch is translatable.
   *
   * @param cursor - The builder position to extend.
   * @param node - The `switch` node to translate.
   * @param document - The document being compiled.
   * @param steps - Accumulated steps by node id.
   * @param resumeSchemas - Accumulated resume schemas by node id.
   * @param degradedSchemas - Accumulated degraded-schema node ids.
   * @returns The extended builder position.
   * @throws {GraphExecutionError} When a case condition is untranslatable or
   *   no branch could be translated.
   */
  private applySwitch(
    cursor: MastraWorkflowBuilderLike,
    node: GraphNodeInstance,
    document: GraphWorkflowDocument,
    steps: Map<string, unknown>,
    resumeSchemas: Map<string, z.ZodTypeAny>,
    degradedSchemas: string[]
  ): MastraWorkflowBuilderLike {
    const metadata = this.switchMetadataOf(node);
    const branches: Array<[unknown, unknown]> = [];
    for (const switchCase of metadata.cases) {
      assertMastraConditionSupported(switchCase.condition, node.id);
      const step = this.targetStep(
        node.id,
        switchCase.outputPort,
        document,
        steps,
        resumeSchemas,
        degradedSchemas
      );
      if (!step) continue;
      branches.push([
        mastraConditionPredicate(switchCase.condition, "switch case"),
        step,
      ]);
    }
    if (metadata.hasDefault === true && metadata.defaultPort) {
      const defaultStep = this.targetStep(
        node.id,
        metadata.defaultPort,
        document,
        steps,
        resumeSchemas,
        degradedSchemas
      );
      if (defaultStep) branches.push([() => true, defaultStep]);
    }
    if (branches.length === 0) {
      throw new GraphExecutionError(
        `Mastra switch node '${node.id}' has no translatable branches`,
        GRAPH_MASTRA_UNSUPPORTED_KIND,
        { nodeId: node.id }
      );
    }
    return cursor.branch(branches);
  }

  /**
   * Translates a loop node by recursively compiling its body document and
   * applying it as a `foreach`, `do-while`, or `do-until` loop.
   *
   * @param cursor - The builder position to extend.
   * @param node - The loop node to translate.
   * @param document - The document being compiled.
   * @param steps - Accumulated steps by node id.
   * @param resumeSchemas - Accumulated resume schemas by node id.
   * @param degradedSchemas - Accumulated degraded-schema node ids.
   * @returns The extended builder position.
   * @throws {GraphExecutionError} When the loop has no body or the condition
   *   is untranslatable.
   */
  private applyLoop(
    cursor: MastraWorkflowBuilderLike,
    node: GraphNodeInstance,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    document: GraphWorkflowDocument,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    steps: Map<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    resumeSchemas: Map<string, z.ZodTypeAny>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    degradedSchemas: string[]
  ): MastraWorkflowBuilderLike {
    const loop = node.loop;
    if (!loop || !loop.body) {
      throw new GraphExecutionError(
        `Mastra loop node '${node.id}' has no loop body to translate`,
        GRAPH_MASTRA_UNSUPPORTED_KIND,
        { nodeId: node.id }
      );
    }
    const body = new MastraWorkflowCompiler({
      stepHandlers: [...this.handlers.values()],
    }).compile(loop.body);
    if (node.kind === GRAPH_MASTRA_FOREACH_KIND) {
      const concurrency =
        typeof loop.concurrency === "number" ? loop.concurrency : undefined;
      return cursor.foreach(
        body.workflow,
        concurrency !== undefined ? { concurrency } : undefined
      );
    }
    const condition = this.conditionOf(node);
    assertMastraConditionSupported(condition, node.id);
    const predicate = mastraConditionPredicate(condition!, "loop");
    if (node.kind === GRAPH_MASTRA_WHILE_KIND) {
      return cursor.dowhile(body.workflow, predicate);
    }
    return cursor.dountil(body.workflow, predicate);
  }

  /**
   * Translates a human-approval node into a suspending Mastra step with a
   * validated resume schema (C15); a non-approved resume is reported as a
   * rejected outcome.
   *
   * @param cursor - The builder position to extend.
   * @param node - The human-approval node to translate.
   * @param steps - Accumulated steps by node id.
   * @param resumeSchemas - Accumulated resume schemas by node id.
   * @param degradedSchemas - Accumulated degraded-schema node ids.
   * @returns The extended builder position.
   * @throws {GraphExecutionError} When the declared resume schema is unsafe.
   */
  private applyHumanApproval(
    cursor: MastraWorkflowBuilderLike,
    node: GraphNodeInstance,
    steps: Map<string, unknown>,
    resumeSchemas: Map<string, z.ZodTypeAny>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    degradedSchemas: string[]
  ): MastraWorkflowBuilderLike {
    const parameters = node.parameters ?? {};
    const suspendSchema = toMastraZodSchema(
      parameters["suspendSchema"] as never
    );
    const resumeSchema = assertMastraResumeSchemaSafe(
      parameters["resumeSchema"] as never
    );
    resumeSchemas.set(node.id, resumeSchema);
    const step = stampDecafNodeOrigin(
      createStep({
        id: node.id,
        inputSchema: z.any(),
        outputSchema: z.any(),
        suspendSchema: suspendSchema.schema,
        resumeSchema,
        execute: async (args: {
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
      }),
      node
    );
    steps.set(node.id, step);
    return cursor.then(step);
  }

  /**
   * Translates a leaf node through its registered step handler and records
   * degraded output schemas.
   *
   * @param node - The leaf node to translate.
   * @param steps - Accumulated steps by node id.
   * @param degradedSchemas - Accumulated degraded-schema node ids.
   * @returns The created Mastra step.
   * @throws {GraphExecutionError} {@link GRAPH_MASTRA_UNSUPPORTED_KIND} when no
   *   handler is registered for the node kind.
   */
  private buildLeafStep(
    node: GraphNodeInstance,
    steps: Map<string, unknown>,
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
    const step = stampDecafNodeOrigin(
      handler.createStep(node, { stepId: node.id, document }),
      node
    );
    steps.set(node.id, step);
    const schema = toMastraZodSchema(node.metadata?.["outputSchema"] as never);
    if (schema.degraded) degradedSchemas.push(node.id);
    return step;
  }

  /**
   * Resolves the Mastra step a control node's output port routes to, by
   * following the first data edge leaving that port.
   *
   * @param nodeId - The control node id the port belongs to.
   * @param port - The output port whose routing edge to follow.
   * @param document - The document being compiled.
   * @param steps - Accumulated steps by node id.
   * @param resumeSchemas - Accumulated resume schemas by node id.
   * @param degradedSchemas - Accumulated degraded-schema node ids.
   * @returns The target step, or `undefined` when the port routes nowhere.
   */
  private targetStep(
    nodeId: string,
    port: string,
    document: GraphWorkflowDocument,
    steps: Map<string, unknown>,
    resumeSchemas: Map<string, z.ZodTypeAny>,
    degradedSchemas: string[]
  ): unknown {
    const target = (document.edges ?? []).find(
      (edge) =>
        edge.type === "data" &&
        nodeEndpointId(edge, "source") === nodeId &&
        edge.source.port === port
    );
    if (!target) return undefined;
    const targetId = nodeEndpointId(target, "target");
    if (!targetId) return undefined;
    const existing = steps.get(targetId);
    if (existing) return existing;
    const targetNode = (document.nodes ?? []).find(
      (candidate) => candidate.id === targetId
    );
    if (!targetNode) return undefined;
    return this.buildLeafStep(targetNode, steps, degradedSchemas, document);
  }

  /**
   * Reads the canonical condition attached to a node's parameters.
   *
   * @param node - The node whose condition to read.
   * @returns The condition, or `undefined` when none is declared.
   */
  private conditionOf(node: GraphNodeInstance): Condition | undefined {
    const parameters = node.parameters ?? {};
    const candidate = parameters["condition"];
    return candidate as Condition | undefined;
  }

  /**
   * Resolves a switch node's case metadata, preferring node metadata and
   * falling back to parameter-declared cases.
   *
   * @param node - The `switch` node to read.
   * @returns The resolved switch metadata.
   */
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
