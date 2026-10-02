/**
 * @module as-graph/pinning/GraphPinningService
 * @summary Service for pinning and unpinning graph node values (DECAF-50 §4.9).
 * @description Computes stable fingerprints, pins/unpins nodes and their
 * upstream dependencies, reads pinned values, and emits pinning events.
 * Pinning is all-or-nothing: if any upstream dependency is not pinnable, the
 * operation fails.
 *
 * Fingerprints derive from the node kind, parameters, bindings, effective
 * inputs, relevant metadata, and configured dependency fingerprints
 * (DECAF-50 §4.9). Presentation-only UI state (node/canvas positions, colors,
 * and every `ui` record) is excluded — moving a node on the canvas never
 * invalidates its pinned value.
 */
import { GRAPH_PINNING_METADATA_KEY } from "../constants";
import { GraphPinningError } from "../errors/GraphPinningError";
import type { GraphExecutionPlan } from "../planning/GraphExecutionPlan";
import type { GraphExecutionPlanNode } from "../planning/GraphExecutionPlanNode";
import { GraphTopology } from "../planning/GraphTopology";
import type { GraphValueRepository } from "../store/GraphValueRepository";
import type { GraphValueKey } from "../store/GraphValueKey";
import type { GraphCachedValue } from "../store/GraphCachedValue";
import type {
  GraphExecutionResult,
  GraphExecutionValues,
  GraphPinNodeOptions,
  GraphUnpinNodeOptions,
} from "../types";

import type { GraphPinningPolicy } from "./GraphPinningPolicy";
import type { GraphPinningDependencyResolver } from "./GraphPinningDependencyResolver";

/**
 * Service that manages pinning and unpinning of graph node values.
 */
export class GraphPinningService {
  constructor(
    private readonly store: GraphValueRepository,
    private readonly policy: GraphPinningPolicy,
    private readonly dependencyResolver: GraphPinningDependencyResolver
  ) {}

  /**
   * Pins a node and all its upstream dependencies.
   *
   * @throws {GraphPinningError} when the node or any dependency is not pinnable.
   */
  async pinNode(options: GraphPinNodeOptions): Promise<void> {
    const plan = options.plan as GraphExecutionPlan;
    const includeDependencies = options.includeDependencies ?? true;

    const pinSet = includeDependencies
      ? this.dependencyResolver.getPinSet(plan, options.nodeId)
      : new Set([options.nodeId]);

    // Validate all-or-nothing
    for (const nodeId of pinSet) {
      const node = plan.nodes.find((n) => n.id === nodeId);
      if (!node) {
        throw new GraphPinningError(`Node '${nodeId}' not found in plan`);
      }
      if (!this.policy.canPin(node)) {
        throw new GraphPinningError(
          `Node '${nodeId}' is not pinnable`,
          { nodeId }
        );
      }
    }

    // Pin dependencies first, then the selected node
    const ordered = this.topologicalOrder(plan, pinSet);
    for (const nodeId of ordered) {
      const node = plan.nodes.find((n) => n.id === nodeId)!;
      const result = options.result.nodeResults[nodeId];
      if (!result || !result.outputs) {
        throw new GraphPinningError(
          `Node '${nodeId}' has no completed output to pin`
        );
      }
      const inputs = result.inputs ?? {};
      const depFingerprints = this.dependencyFingerprints(plan, nodeId, options.result);
      const key = this.createValueKey(options.document.id, node, inputs, depFingerprints);
      const now = new Date().toISOString();
      const cached: GraphCachedValue = {
        key,
        outputs: result.outputs,
        pinned: true,
        createdAt: now,
        updatedAt: now,
        metadata: { ...options.result.metadata, nodeId },
      };
      await this.store.writeCached(key, cached);
    }
  }

  /**
   * Unpins a single node (does not unpin dependents in v1).
   */
  async unpinNode(options: GraphUnpinNodeOptions): Promise<void> {
    const key: GraphValueKey = {
      workflowId: options.document.id,
      nodeId: options.nodeId,
      fingerprint: options.fingerprint,
      namespace: options.namespace,
    };
    await this.store.deleteCached(key);
  }

  /**
   * Reads a pinned value for a node, returning `undefined` when no valid
   * pinned value exists.
   */
  async readPinnedValue(
    workflowId: string,
    node: GraphExecutionPlanNode,
    inputs: GraphExecutionValues,
    dependencyFingerprints: Record<string, string>,
    namespace?: string
  ): Promise<GraphCachedValue | undefined> {
    const key = this.createValueKey(workflowId, node, inputs, dependencyFingerprints, namespace);
    const cached = await this.store.readCached(key);
    if (cached && cached.pinned) {
      if (cached.expiresAt && new Date(cached.expiresAt) < new Date()) {
        return undefined;
      }
      return cached;
    }
    return undefined;
  }

  /**
   * Creates a stable value key for a node.
   */
  createValueKey(
    workflowId: string,
    node: GraphExecutionPlanNode,
    inputs: GraphExecutionValues,
    dependencyFingerprints: Record<string, string>,
    namespace?: string
  ): GraphValueKey {
    return {
      workflowId,
      nodeId: node.id,
      fingerprint: this.computeFingerprint(workflowId, node, inputs, dependencyFingerprints),
      namespace,
    };
  }

  /**
   * Computes a stable fingerprint for a node (DECAF-50 §4.9).
   *
   * The fingerprint derives from the node kind, the instance parameters, the
   * input bindings, the effective input values, relevant instance metadata,
   * and the configured dependency fingerprints. Presentation-only UI state is
   * excluded: the instance `ui` record is never read, and a `ui` key inside
   * metadata is stripped, so canvas positions and visual settings cannot
   * affect pinning.
   */
  computeFingerprint(
    workflowId: string,
    node: GraphExecutionPlanNode,
    inputs: GraphExecutionValues,
    dependencyFingerprints: Record<string, string>
  ): string {
    const data = {
      workflowId,
      nodeId: node.id,
      nodeKind: node.kind,
      parameters: this.stableSerialize(node.instance.parameters ?? {}),
      inputBindings: this.stableSerialize(node.instance.inputBindings ?? {}),
      metadata: this.stableSerialize(this.relevantMetadata(node)),
      inputs: this.stableSerialize(inputs),
      dependencyFingerprints: this.stableSerialize(dependencyFingerprints),
    };
    const json = this.stableSerialize(data);
    // Use a deterministic non-cryptographic hash that works in both browser
    // and Node environments without requiring `node:crypto`.
    return this.simpleHash(json);
  }

  /**
   * Strips presentation-only keys (`ui` and UI-state shapes) from the node's
   * instance metadata, leaving only pinning-relevant metadata.
   */
  private relevantMetadata(node: GraphExecutionPlanNode): Record<string, unknown> {
    const metadata: Record<string, unknown> = { ...(node.metadata ?? {}) };
    delete metadata["ui"];
    delete metadata["position"];
    delete metadata["visual"];
    return metadata;
  }

  /**
   * Returns a topological ordering of the given node set.
   */
  private topologicalOrder(
    plan: GraphExecutionPlan,
    nodeSet: Set<string>
  ): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const visit = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const deps = GraphTopology.upstreamNodes(nodeId, plan.incomingByNode, false);
      for (const dep of deps) {
        if (nodeSet.has(dep)) visit(dep);
      }
      result.push(nodeId);
    };
    for (const nodeId of nodeSet) visit(nodeId);
    return result;
  }

  /**
   * Computes fingerprints for all upstream dependencies of a node.
   */
  private dependencyFingerprints(
    plan: GraphExecutionPlan,
    nodeId: string,
    result: GraphExecutionResult
  ): Record<string, string> {
    const deps = this.dependencyResolver.getDependencies(plan, nodeId);
    const fingerprints: Record<string, string> = {};
    for (const dep of deps) {
      const node = plan.nodes.find((n) => n.id === dep);
      if (node) {
        const depResult = result.nodeResults[dep];
        const inputs = depResult?.inputs ?? {};
        const nestedDeps = this.dependencyFingerprints(plan, dep, result);
        fingerprints[dep] = this.computeFingerprint(plan.workflowId, node, inputs, nestedDeps);
      }
    }
    return fingerprints;
  }

  /**
   * Serializes a value with recursively sorted keys for stable hashing.
   */
  private stableSerialize(value: unknown): string {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((v) => this.stableSerialize(v)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    const pairs = keys.map(
      (k) => `${JSON.stringify(k)}:${this.stableSerialize((value as any)[k])}`
    );
    return `{${pairs.join(",")}}`;
  }

  /**
   * Simple non-cryptographic hash for browser environments where
   * `node:crypto` is unavailable. Produces a deterministic hex-like string
   * from the input. This is NOT cryptographically secure but is sufficient
   * for fingerprint-based cache keys.
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return `fp_${Math.abs(hash).toString(16).padStart(8, "0")}_${str.length}`;
  }
}

void GRAPH_PINNING_METADATA_KEY;
